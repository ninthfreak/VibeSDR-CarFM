package com.ninthfreak.nwdprobe;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.database.ContentObserver;
import android.database.Cursor;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.RemoteException;
import android.provider.MediaStore;
import android.provider.Settings;
import android.text.method.ScrollingMovementMethod;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.nwd.radio.service.RadioCallback;
import com.nwd.radio.service.RadioFeature;
import com.nwd.radio.service.data.Frequency;
import com.nwd.radio.service.data.RadioPoint;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ArrayBlockingQueue;

/**
 * NWD built-in FM tuner — EXHAUSTIVE INTERACTIVE probe.
 *
 * "RUN FULL TEST" drives a scripted, self-tuning sequence over the target
 * stations and the source-gate write experiment, pausing to ASK you ground-truth
 * questions (buttons) or INSTRUCT you to do something it can't (open the stock
 * app, grant a permission) and wait for you to confirm. Everything — machine
 * readings and your answers — lands in one timestamped log saved to Downloads.
 *
 * Throwaway RE harness, NOT the CarFM backend. AIDL is a clean-room reconstruction.
 */
public class MainActivity extends Activity {

    private static final String BIND_ACTION = "com.nwd.radio.service.ACTION_RADIO_SERVICE";
    private static final String SERVICE_PKG = "com.nwd.radio.service";
    private static final String SRC_KEY = "mcu_current_source";
    private static final int SRC_FM = 4;
    private static final double[] TEST_FREQS = { 88.7, 101.5 };   // per request

    private RadioFeature radio;
    private TextView log;
    private EditText mhzField, bandField;
    private int freqMult = 1000;
    private byte fmBand = 0;

    private final StringBuilder logBuf = new StringBuilder();
    private final ArrayBlockingQueue<String> answer = new ArrayBlockingQueue<>(1);
    private volatile boolean testRunning = false;
    private ContentObserver sourceObserver;

    // ── UI ────────────────────────────────────────────────────────────────────
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(10);
        root.setPadding(pad, pad, pad, pad);

        Button full = btn("▶  RUN FULL TEST (auto + guided)", v -> runFullTest());
        full.setTextSize(16f);
        root.addView(full);

        root.addView(btn("Connect", v -> connect()));

        LinearLayout tuneRow = new LinearLayout(this);
        tuneRow.setOrientation(LinearLayout.HORIZONTAL);
        mhzField = new EditText(this); mhzField.setText("88.7");
        mhzField.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 2f));
        bandField = new EditText(this); bandField.setText("0");
        bandField.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1f));
        tuneRow.addView(label("MHz")); tuneRow.addView(mhzField);
        tuneRow.addView(label("band")); tuneRow.addView(bandField);
        root.addView(tuneRow);

        LinearLayout manual = new LinearLayout(this);
        manual.setOrientation(LinearLayout.HORIZONTAL);
        manual.addView(weighted(btn("Tune", v -> tuneMhz())));
        manual.addView(weighted(btn("Seek ▼", v -> seek(false))));
        manual.addView(weighted(btn("Seek ▲", v -> seek(true))));
        manual.addView(weighted(btn("Dump", v -> dumpAll("manual"))));
        root.addView(manual);

        LinearLayout srcRow = new LinearLayout(this);
        srcRow.setOrientation(LinearLayout.HORIZONTAL);
        srcRow.addView(weighted(btn("Source probe", v -> sourceSettingsDump())));
        srcRow.addView(weighted(btn("Save log", v -> saveLog())));
        root.addView(srcRow);

        log = new TextView(this);
        log.setTextSize(11f);
        log.setMovementMethod(new ScrollingMovementMethod());
        log.setTypeface(android.graphics.Typeface.MONOSPACE);
        ScrollView sv = new ScrollView(this);
        sv.addView(log);
        root.addView(sv);

        setContentView(root);
        line("Ready. Park on a station, then tap RUN FULL TEST. Answer the prompts.");
    }

    // ── Binding ─────────────────────────────────────────────────────────────
    private void connect() {
        if (radio != null) { line("already connected"); return; }
        Intent i = new Intent(BIND_ACTION).setPackage(SERVICE_PKG);
        boolean ok = bindService(i, conn, Context.BIND_AUTO_CREATE);
        line("bindService returned " + ok + (ok ? "" : "  <-- FALSE = not bindable"));
    }

    private final ServiceConnection conn = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            radio = RadioFeature.Stub.asInterface(binder);
            line("CONNECTED to " + name.flattenToShortString());
            try { radio.registCallback(callback); line("registCallback OK"); }
            catch (RemoteException e) { line("registCallback FAILED: " + e); }
            startSourceObserver();
        }
        @Override public void onServiceDisconnected(ComponentName name) { radio = null; line("DISCONNECTED"); }
    };

    // ── The full interactive test ─────────────────────────────────────────────
    private void runFullTest() {
        if (testRunning) { line("test already running"); return; }
        testRunning = true;
        new Thread(this::fullTestBody, "nwd-fulltest").start();
    }

    private void fullTestBody() {
        line("\n==== FULL TEST START ====");
        if (radio == null) { runOnUiThread(this::connect); }
        for (int i = 0; radio == null && i < 12; i++) sleep(500);
        if (radio == null) { line("could not connect — aborting"); testRunning = false; return; }

        dumpAll("baseline");
        sourceSettingsDump();

        // Permission gate up front — avoids mid-test lifecycle dialogs.
        boolean canWrite = canWrite();
        if (!canWrite) {
            instruct("This test writes one system setting (mcu_current_source) to try to unlock RadioText.\n\n"
                   + "Tap Done to open the grant screen, enable \"modify system settings\" for NWD Tuner Probe, "
                   + "then come back and press RUN FULL TEST again.");
            openGrantScreen();
            line("Grant the permission, then press RUN FULL TEST again. (Saving what we have so far.)");
            saveLog();
            testRunning = false;
            return;
        }

        // PHASE 1 — passive per-station dump + ground truth
        for (double mhz : TEST_FREQS) {
            line("\n-- station " + mhz + " (passive) --");
            tuneMhzTo(mhz); sleep(3000);
            dumpAll("tuned " + mhz);
            String sound = ask("Tuned to " + mhz + ". How does it sound?", "Clear", "Weak / static", "Silent");
            line("watching 8s for cb RT/PS on " + mhz + " (sound=" + sound + ")…"); sleep(8000);
        }

        // PHASE 2 — RDS selector sweep
        line("\n-- RDS selector sweep --");
        for (int s = 0; s < 4; s++) { try { radio.setRDSState((byte) s, true); } catch (Exception ignored) {} }
        dumpAll("after setRDSState 0..3 = true");

        // PHASE 3 — source-gate WRITE test (the main event)
        for (double mhz : TEST_FREQS) {
            line("\n-- source WRITE test @ " + mhz + " --");
            sourceWriteTest(mhz);
        }

        // PHASE 4 — stock-app A/B (needs you; the dialog stays up while you're away)
        instruct("STOCK-APP COMPARISON.\n\nOpen the STOCK radio app, tune it to " + TEST_FREQS[0]
               + ", let it play ~15s so RDS locks, then come back here and tap Done.\n\n"
               + "(This probe stays bound the whole time — we'll re-read the tuner with the stock app as the real source.)");
        dumpAll("stock-app active");
        String rtSeen = ask("With the stock app active, did this probe's log show any \"cb RT '…'\" lines (RadioText)?", "Yes", "No");
        line("stock-app RadioText seen: " + rtSeen);
        instruct("You can close the stock app now. Tap Done to finish.");

        // PHASE 5 — audio ground truth
        String audio = ask("Across the whole test, did FM audio ever actually play through the speakers?", "Yes", "No");
        line("audio played: " + audio);

        saveLog();
        line("==== FULL TEST DONE ====");
        testRunning = false;
    }

    // ── Test steps ──────────────────────────────────────────────────────────
    private void sourceWriteTest(double mhz) {
        tuneMhzTo(mhz); sleep(2000);
        int orig = readSource();
        line("  orig " + SRC_KEY + "=" + orig);
        boolean wrote = false;
        try { wrote = Settings.System.putInt(getContentResolver(), SRC_KEY, SRC_FM); }
        catch (Exception e) { line("  putInt threw " + e); }
        int rb = readSource();
        line("  putInt(4)=" + wrote + " readback=" + rb + " stuck=" + (rb == SRC_FM));
        line("  holding source=FM 12s — watching getRtMessage/isStreroOn + callbacks…");
        for (int i = 0; i < 4; i++) {
            sleep(3000);
            try { line("    t+" + ((i + 1) * 3) + "s rt='" + radio.getRtMessage() + "' stereo=" + radio.isStreroOn()); }
            catch (Exception ignored) {}
        }
        String r = ask("On " + mhz + " with source forced to FM — what happened?",
                "RadioText / station text appeared", "Audio started", "Both", "Nothing");
        line("  write-test result @ " + mhz + ": " + r);
        if (orig >= 0) { try { Settings.System.putInt(getContentResolver(), SRC_KEY, orig); } catch (Exception ignored) {} line("  restored " + SRC_KEY + " to " + orig); }
    }

    private void dumpAll(String tag) {
        if (radio == null) return;
        line("---- dump: " + tag + " ----");
        try { line("  radioType=" + radio.getRadioType() + " state=" + radio.getRadioState() + " scan=" + radio.getCurrentScanState()); } catch (Exception e) { line("  err " + e); }
        try {
            Frequency f = radio.getCurrentFrequency();
            if (f != null) { fmBand = f.band; int fv = f.freq; freqMult = fv > 50000 ? 1000 : fv > 5000 ? 100 : fv > 500 ? 10 : 1;
                line("  freq raw=" + fv + " (" + (fv / (double) freqMult) + " MHz) band=" + f.band + " PS='" + f.psName + "'"); }
        } catch (Exception e) { line("  freq err " + e); }
        try { line("  isStreroOn=" + radio.isStreroOn() + " isHasStrero=" + radio.isHasStrero() + " isNearOn=" + radio.isNearOn() + " backSvc=" + radio.isRadioBackServiceOn()); } catch (Exception e) { line("  err " + e); }
        try { line("  pty=" + radio.getPTYType() + " prefabPty=" + radio.getPrefabPTYType() + " rt='" + radio.getRtMessage() + "'"); } catch (Exception e) { line("  err " + e); }
        StringBuilder rds = new StringBuilder();
        for (int s = 0; s < 4; s++) { try { rds.append(s).append('=').append(radio.getRDSState(s)).append(' '); } catch (Exception e) { rds.append(s).append("=err "); } }
        line("  rdsState " + rds);
        try { RadioPoint[] pts = radio.getRadioPoint(); if (pts != null) { StringBuilder sb = new StringBuilder(); for (RadioPoint p : pts) sb.append(p).append("; "); line("  bandPlan " + sb); } } catch (Exception e) { line("  bandplan err " + e); }
        try { Frequency[] pf = radio.getPrefabFrequency(); if (pf != null) { StringBuilder sb = new StringBuilder("[" + pf.length + "] "); for (Frequency p : pf) sb.append(p.freq).append('/').append(p.psName).append(','); line("  presets " + sb); } } catch (Exception e) { line("  presets err " + e); }
    }

    private void sourceSettingsDump() {
        line("---- source settings ----");
        line("  WRITE_SETTINGS granted=" + canWrite());
        line("  " + SRC_KEY + "=" + readSource() + " (FM would be " + SRC_FM + ")");
        try {
            Cursor c = getContentResolver().query(Settings.System.CONTENT_URI, null, null, null, null);
            if (c != null) {
                int ni = c.getColumnIndex("name"), vi = c.getColumnIndex("value"); int total = 0;
                StringBuilder m = new StringBuilder();
                while (c.moveToNext()) {
                    total++;
                    String n = ni >= 0 ? c.getString(ni) : null;
                    String v = vi >= 0 ? c.getString(vi) : null;
                    if (n != null && n.matches("(?i).*(mcu|radio|source|antenna|fm|rds|tuner).*")) m.append("    ").append(n).append(" = ").append(v).append('\n');
                }
                c.close();
                line("  Settings.System rows=" + total + "; matching:\n" + m);
            } else line("  Settings.System not enumerable on this ROM");
        } catch (Exception e) { line("  enumerate err " + e); }
    }

    private int readSource() { try { return Settings.System.getInt(getContentResolver(), SRC_KEY, -1); } catch (Exception e) { return -1; } }
    private boolean canWrite() { try { return Settings.System.canWrite(this); } catch (Exception e) { return false; } }
    private void openGrantScreen() {
        try { startActivity(new Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:" + getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
        catch (Exception e) { line("open grant screen failed " + e); }
    }

    private void startSourceObserver() {
        if (sourceObserver != null) return;
        sourceObserver = new ContentObserver(new Handler(Looper.getMainLooper())) {
            @Override public void onChange(boolean self) { line("OBS " + SRC_KEY + " -> " + readSource()); }
        };
        try { getContentResolver().registerContentObserver(Settings.System.getUriFor(SRC_KEY), false, sourceObserver); line("source observer on"); }
        catch (Exception e) { line("observer reg failed " + e); sourceObserver = null; }
    }

    // ── Interactive primitives (called only from the worker thread) ────────────
    /** Multiple-choice question; blocks the worker until a button is tapped. */
    private String ask(String q, String... options) {
        line("Q: " + q);
        answer.clear();
        runOnUiThread(() -> {
            try {
                new AlertDialog.Builder(this).setTitle("Question").setMessage(q).setCancelable(false)
                        .setItems(options, (d, which) -> answer.offer(options[which])).show();
            } catch (Exception e) { line("dialog failed: " + e); answer.offer("(dialog-failed)"); }
        });
        try { String a = answer.take(); line("A: " + a); return a; } catch (InterruptedException e) { return ""; }
    }

    /** Instruction; blocks until you tap Done (or Skip). Show it while foreground —
     *  the dialog stays up while you visit another app, and you tap Done on return. */
    private boolean instruct(String text) {
        line("STEP: " + text.replace('\n', ' '));
        answer.clear();
        runOnUiThread(() -> {
            try {
                new AlertDialog.Builder(this).setTitle("Do this, then confirm").setMessage(text).setCancelable(false)
                        .setPositiveButton("Done", (d, w) -> answer.offer("done"))
                        .setNegativeButton("Skip", (d, w) -> answer.offer("skip")).show();
            } catch (Exception e) { line("dialog failed: " + e); answer.offer("skip"); }
        });
        try { boolean done = "done".equals(answer.take()); line(done ? "  → confirmed" : "  → skipped"); return done; } catch (InterruptedException e) { return false; }
    }

    // ── Manual actions ────────────────────────────────────────────────────────
    private void tuneMhz() { try { tuneMhzTo(Double.parseDouble(mhzField.getText().toString().trim())); } catch (Exception e) { line("bad MHz: " + e); } }
    private void tuneMhzTo(double mhz) {
        if (radio == null) { line("not connected"); return; }
        try { int raw = (int) Math.round(mhz * freqMult); line("tune " + mhz + " (raw " + raw + ", band " + fmBand + ")"); radio.setCurrentFrequency(raw, fmBand, 0); }
        catch (RemoteException e) { line("tune FAILED: " + e); }
    }
    private void seek(boolean up) { if (radio == null) { line("not connected"); return; } try { radio.seek(up); line("seek(" + (up ? "up" : "down") + ")"); } catch (RemoteException e) { line("seek FAILED: " + e); } }

    // ── Callbacks (Binder thread) ─────────────────────────────────────────────
    private final RadioCallback.Stub callback = new RadioCallback.Stub() {
        public void notifyState(byte s) { line("cb state " + s); }
        public void notifyCurrentFrequency(byte band, int freq, String ps, int arg) { line("cb FREQ " + (freq / (double) freqMult) + " MHz PS='" + ps + "' arg=" + arg); }
        public void notifyNearOn(boolean on) { line("cb nearOn " + on); }
        public void notifyStereo(boolean on) { line("cb stereo " + on); }
        public void notifyStereoOn(boolean on) { line("cb stereoOn " + on); }
        public void notifyRDSStateChange() { line("cb RDSStateChange"); }
        public void notifyCurrentPTYType(byte pty) { line("cb PTY " + pty); }
        public void notifyPrefabFrequency(Frequency[] a) { line("cb prefab[" + (a == null ? 0 : a.length) + "]"); }
        public void notifyPrefabPTYType(byte pty) { line("cb prefabPTY " + pty); }
        public void notifyRadioPoint(RadioPoint[] a) { line("cb radioPoint[" + (a == null ? 0 : a.length) + "]"); }
        public void notifyCurrentIsTA(boolean ta) { line("cb TA " + ta); }
        public void notifyRdsShowState(boolean on) { line("cb rdsShow " + on); }
        public void notifyRtMessage(String rt) { line("cb RT '" + rt + "'"); }
        public void notifyRadioScanState(int state) { line("cb scanState " + state); }
    };

    // ── Save / helpers ─────────────────────────────────────────────────────────
    private void saveLog() {
        String name = "nwdprobe-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date()) + ".txt";
        String text; synchronized (logBuf) { text = logBuf.toString(); }
        try {
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
                cv.put(MediaStore.Downloads.MIME_TYPE, "text/plain");
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                if (uri != null) { OutputStream os = getContentResolver().openOutputStream(uri); os.write(text.getBytes()); os.close(); line("SAVED -> Downloads/" + name); return; }
            }
            File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            File f = new File(dir, name); FileOutputStream fo = new FileOutputStream(f); fo.write(text.getBytes()); fo.close();
            line("SAVED -> " + f.getAbsolutePath());
        } catch (Exception e) { line("save failed (screenshot the log instead): " + e); }
    }

    private void sleep(long ms) { try { Thread.sleep(ms); } catch (InterruptedException ignored) {} }
    private final SimpleDateFormat ts = new SimpleDateFormat("HH:mm:ss", Locale.US);
    private void line(final String s) {
        android.util.Log.i("nwdprobe", s);
        final String stamped = ts.format(new Date()) + "  " + s + "\n";
        synchronized (logBuf) { logBuf.append(stamped); }
        runOnUiThread(() -> {
            log.append(stamped);
            final int amount = log.getLayout() == null ? 0 : log.getLayout().getLineTop(log.getLineCount()) - log.getHeight();
            if (amount > 0) log.scrollTo(0, amount);
        });
    }
    private Button btn(String t, View.OnClickListener l) { Button b = new Button(this); b.setText(t); b.setOnClickListener(l); return b; }
    private TextView label(String t) { TextView v = new TextView(this); v.setText(" " + t + " "); return v; }
    private View weighted(View v) { v.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1f)); return v; }
    private int dp(int v) { return (int) (v * getResources().getDisplayMetrics().density); }

    @Override protected void onDestroy() {
        try { if (sourceObserver != null) getContentResolver().unregisterContentObserver(sourceObserver); } catch (Exception ignored) {}
        try { if (radio != null) radio.unRegistCallback(callback); } catch (Exception ignored) {}
        try { unbindService(conn); } catch (Exception ignored) {}
        super.onDestroy();
    }
}
