package com.ninthfreak.nwdprobe;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.ServiceConnection;
import android.database.ContentObserver;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.RemoteException;
import android.provider.Settings;
import android.text.method.ScrollingMovementMethod;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.content.ContentValues;
import android.net.Uri;
import android.provider.MediaStore;

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
 * NWD built-in FM tuner — STANDALONE-AUDIO probe.
 *
 * ONE question: can FM audio be brought up WITHOUT launching the stock radio app?
 *
 * From decompiling com.nwd.radio.service (Spreadtrum path, SprdRadioManager$1):
 * the audio routing (openDevice + audio focus + AudioSystem.setForceUse +
 * setNwdStreamMute unmute) all runs INSIDE the service. A bound/running service
 * starts it in response to broadcasts the stock app fires on itself — with NO
 * permission or caller check on the receiver:
 *   • com.nwd.action.ACTION_APP_IN_OUT   extra_app_id (int)  == 8  -> InitFM()
 *   • com.nwd.ACTION_MEDIA_PLAY          extra_app_id (int)  == 8  -> InitFM()
 *   • com.nwd.action.ACTION_CHANGE_SOURCE extra_source_id(byte)==4 -> (FM)
 *   • com.nwd.android.ACTION_EXIT_ARM_FM_RAIDO                     -> ExitFm()
 * (Writing mcu_current_source directly — what the old probe did — is a DEAD END:
 * it needs system perms and the MCU re-asserts it. Not tested here.)
 *
 * "RUN AUDIO TEST" climbs a ladder of bring-up attempts, stopping at the first
 * one that produces sound. It asks you ONE thing per rung — "is audio playing?" —
 * via INLINE BUTTONS in this screen (not a dialog; dialogs here previously locked
 * up). All machine state + your answers land in one log saved to Downloads.
 *
 * Throwaway RE harness, NOT the CarFM backend. AIDL is a clean-room reconstruction.
 */
public class MainActivity extends Activity {

    private static final String SERVICE_PKG = "com.nwd.radio.service";
    private static final String SERVICE_CLS = "com.nwd.radio.service.RadioService";
    private static final String BIND_ACTION = "com.nwd.radio.service.ACTION_RADIO_SERVICE";
    private static final String SRC_KEY = "mcu_current_source";
    private static final double STRONG_MHZ = 101.5;   // user reports this comes in best

    private RadioFeature radio;
    private TextView log;
    private EditText mhzField, bandField;
    private int freqMult = 1000;
    private byte fmBand = 0;
    private MediaPlayer vendorMp;

    // Inline prompt panel (replaces AlertDialogs, which locked up when a message
    // and a list were set together). Real buttons in the activity's own view —
    // no window token, survives pause/resume.
    private LinearLayout promptPanel;
    private TextView promptText;
    private LinearLayout promptButtons;

    private final StringBuilder logBuf = new StringBuilder();
    private final ArrayBlockingQueue<String> answer = new ArrayBlockingQueue<>(1);
    private volatile boolean testRunning = false;
    private ContentObserver sourceObserver;
    private BroadcastReceiver nwdRx;

    // ── UI ────────────────────────────────────────────────────────────────────
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(10);
        root.setPadding(pad, pad, pad, pad);

        Button full = btn("▶  RUN AUDIO TEST (standalone bring-up)", v -> runAudioTest());
        full.setTextSize(16f);
        root.addView(full);

        // Inline prompt panel — hidden until a question/instruction is posted.
        promptPanel = new LinearLayout(this);
        promptPanel.setOrientation(LinearLayout.VERTICAL);
        promptPanel.setBackgroundColor(0xFF203040);
        int pp = dp(12);
        promptPanel.setPadding(pp, pp, pp, pp);
        promptText = new TextView(this);
        promptText.setTextSize(16f);
        promptText.setTextColor(Color.WHITE);
        promptButtons = new LinearLayout(this);
        promptButtons.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams btnRowLp = new LinearLayout.LayoutParams(-1, -2);
        btnRowLp.topMargin = dp(8);
        promptButtons.setLayoutParams(btnRowLp);
        promptPanel.addView(promptText);
        promptPanel.addView(promptButtons);
        promptPanel.setVisibility(View.GONE);
        root.addView(promptPanel);

        // Manual controls (ad-hoc; the scripted test doesn't need them).
        root.addView(btn("Connect (bind service)", v -> wakeAndBind()));

        LinearLayout tuneRow = new LinearLayout(this);
        tuneRow.setOrientation(LinearLayout.HORIZONTAL);
        mhzField = new EditText(this); mhzField.setText(String.valueOf(STRONG_MHZ));
        mhzField.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 2f));
        bandField = new EditText(this); bandField.setText("0");
        bandField.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1f));
        tuneRow.addView(label("MHz")); tuneRow.addView(mhzField);
        tuneRow.addView(label("band")); tuneRow.addView(bandField);
        root.addView(tuneRow);

        LinearLayout manual = new LinearLayout(this);
        manual.setOrientation(LinearLayout.HORIZONTAL);
        manual.addView(weighted(btn("Tune", v -> tuneMhz())));
        manual.addView(weighted(btn("Dump", v -> snap("manual"))));
        manual.addView(weighted(btn("Save log", v -> saveLog())));
        root.addView(manual);

        // Manual broadcast rungs (fire any bring-up trigger by hand).
        LinearLayout bcRow = new LinearLayout(this);
        bcRow.setOrientation(LinearLayout.HORIZONTAL);
        bcRow.addView(weighted(btn("APP_IN_OUT 8", v -> sendAppInOut(8))));
        bcRow.addView(weighted(btn("MEDIA_PLAY 8", v -> sendMediaPlay(8))));
        bcRow.addView(weighted(btn("REQ SRC 4", v -> sendRequestSource((byte) 4))));
        bcRow.addView(weighted(btn("EXIT FM", v -> sendExitFm())));
        root.addView(bcRow);

        log = new TextView(this);
        log.setTextSize(11f);
        log.setMovementMethod(new ScrollingMovementMethod());
        log.setTypeface(Typeface.MONOSPACE);
        ScrollView sv = new ScrollView(this);
        sv.addView(log);
        root.addView(sv);

        setContentView(root);
        line("Ready. Volume UP, stock radio app CLOSED, then tap RUN AUDIO TEST.");
    }

    // ── Service wake + binding ─────────────────────────────────────────────────
    /** Wake (startService) AND bind the radio service by explicit component. The
     *  bring-up receivers are registered dynamically, so the process MUST be alive
     *  for a broadcast to land — binding with AUTO_CREATE guarantees that. */
    private void wakeAndBind() {
        Intent i = new Intent(BIND_ACTION).setComponent(new ComponentName(SERVICE_PKG, SERVICE_CLS));
        try { startService(i); } catch (Exception e) { line("startService threw " + e + " (may need explicit action only)"); }
        try {
            boolean ok = bindService(new Intent(BIND_ACTION).setPackage(SERVICE_PKG), conn, Context.BIND_AUTO_CREATE);
            line("bindService=" + ok + (ok ? "" : "  <-- FALSE = not bindable (service may still be running for broadcasts)"));
        } catch (Exception e) { line("bindService threw " + e); }
    }

    private final ServiceConnection conn = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            radio = RadioFeature.Stub.asInterface(binder);
            line("CONNECTED to " + name.flattenToShortString());
            try { radio.registCallback(callback); line("registCallback OK"); }
            catch (RemoteException e) { line("registCallback FAILED: " + e); }
            startSourceObserver();
            startBroadcastLogger();
            calibrate();
        }
        @Override public void onServiceDisconnected(ComponentName name) { radio = null; line("DISCONNECTED"); }
    };

    // ── The audio bring-up ladder ──────────────────────────────────────────────
    private void runAudioTest() {
        if (testRunning) { line("test already running"); return; }
        testRunning = true;
        new Thread(this::audioTestBody, "nwd-audiotest").start();
    }

    private void audioTestBody() {
        line("\n==== STANDALONE AUDIO BRING-UP TEST ====");
        prompt("This tests whether FM audio can start WITHOUT the stock radio app.\n\n"
             + "• Turn the volume UP.\n"
             + "• Do NOT open the stock radio app during this test.\n\n"
             + "Tap Start.", "Start");

        wakeAndBind();
        for (int i = 0; radio == null && i < 12; i++) sleep(500);
        line("service bound = " + (radio != null) + " (broadcasts can still work if the service is running from boot)");
        snap("baseline");
        int origSrc = readSource();
        sendStopQqMusic(); sleep(500);

        String worked = null;

        // RUNG 1 — the stock app's own FM audio trigger.
        line("\n-- RUNG 1: ACTION_APP_IN_OUT extra_app_id=8  →  service InitFM() --");
        sendAppInOut(8);
        line("waiting 4s (service mutes, unmutes ~1800ms, then powers up FM)…");
        sleep(4000); snap("after RUNG1");
        if (audioYes("RUNG 1")) worked = "RUNG 1 — ACTION_APP_IN_OUT app_id=8";

        // RUNG 2 — same InitFM via the other action.
        if (worked == null) {
            line("\n-- RUNG 2: ACTION_MEDIA_PLAY extra_app_id=8  →  service InitFM() --");
            sendMediaPlay(8); sleep(4000); snap("after RUNG2");
            if (audioYes("RUNG 2")) worked = "RUNG 2 — ACTION_MEDIA_PLAY app_id=8";
        }

        // RUNG 3 — tune via AIDL (Sprd tuneStation → powerUp brings audio on its own).
        // The service's setCurrentFrequency IGNORES a tune to the freq it's already on
        // (freq != current guard), so if it's already parked on the target the tune is
        // a no-op and never powers up. Force a real change first when that's the case.
        if (worked == null) {
            line("\n-- RUNG 3: bind + setCurrentFrequency (Sprd tune→powerUp) --");
            if (radio == null) line("  (not bound — skipping)");
            else {
                double cur = currentMhz();
                if (cur > 0 && Math.abs(cur - STRONG_MHZ) < 0.05) {
                    line("  already on " + STRONG_MHZ + "; nudging to " + (STRONG_MHZ - 0.2) + " first so the tune isn't ignored");
                    tuneMhzTo(STRONG_MHZ - 0.2); sleep(2000);
                }
                tuneMhzTo(STRONG_MHZ); sleep(4000); snap("after RUNG3");
            }
            if (radio != null && audioYes("RUNG 3")) worked = "RUNG 3 — setCurrentFrequency powerUp";
        }

        // RUNG 4 — ask the MCU to physically switch the head-unit source to FM.
        if (worked == null) {
            line("\n-- RUNG 4: ACTION_REQUEST_CHANGE_SOURCE (physical source switch) --");
            prompt("RUNG 4 will ask the head unit to switch its WHOLE audio source to Radio "
                 + "— like pressing 'Radio' on the unit. Tap OK to send.", "OK");
            sendRequestSource((byte) 4); sleep(4000); snap("after RUNG4 src=4");
            boolean yes = audioYes("RUNG 4 (source→4)");
            if (!yes) {
                line("  retrying with extra_source_id=8…");
                sendRequestSource((byte) 8); sleep(4000); snap("after RUNG4 src=8");
                yes = audioYes("RUNG 4 (source→8)");
            }
            if (yes) worked = "RUNG 4 — ACTION_REQUEST_CHANGE_SOURCE";
        }

        // RUNG 5 — public-API long shot (vendor FM URI through MediaPlayer).
        if (worked == null) {
            line("\n-- RUNG 5: MediaPlayer THIRDPARTY://MEDIAPLAYER_PLAYERTYPE_FM (long shot) --");
            tryVendorMediaPlayer(); sleep(3000); snap("after RUNG5");
            if (audioYes("RUNG 5")) worked = "RUNG 5 — vendor MediaPlayer URI";
        }

        line("\n==== RESULT: " + (worked != null ? "AUDIO via " + worked : "NO rung produced audio") + " ====");
        snap("final");
        line("mcu_current_source now = " + readSource() + "  (4 = FM is the active source)");
        // Bonus: if forcing FM as the source also unlocked RadioText, capture it.
        try { line("RDS check: rt='" + radio.getRtMessage() + "' stereo=" + radio.isStreroOn()); } catch (Exception ignored) {}

        // Cleanup — offer to turn the tuner back off / restore the source.
        String c = prompt("Test done. Turn the tuner audio back off?", "Stop FM", "Leave it playing");
        if ("Stop FM".equals(c)) {
            sendExitFm();
            if (origSrc >= 0 && readSource() != origSrc) { sendRequestSource((byte) origSrc); line("requested source back to " + origSrc); }
        }

        saveLog();
        line("==== DONE ====");
        testRunning = false;
    }

    /** One audio yes/no via the inline buttons; true iff the user says audio plays. */
    private boolean audioYes(String rung) {
        return prompt(rung + ": is FM audio playing through the speakers now?", "YES — audio!", "No").startsWith("YES");
    }

    // ── Bring-up broadcasts (exact actions/extras from SprdRadioManager$1) ──────
    private void sendAppInOut(int appId) {
        Intent i = new Intent("com.nwd.action.ACTION_APP_IN_OUT");
        i.putExtra("extra_app_id", appId);
        i.putExtra("extra_app_operation", 1);
        i.putExtra("extra_app_event", 0);
        sendBroadcast(i);
        line("bcast ACTION_APP_IN_OUT extra_app_id=" + appId);
    }
    private void sendMediaPlay(int appId) {
        Intent i = new Intent("com.nwd.ACTION_MEDIA_PLAY");
        i.putExtra("extra_app_id", appId);
        sendBroadcast(i);
        line("bcast ACTION_MEDIA_PLAY extra_app_id=" + appId);
    }
    private void sendRequestSource(byte src) {
        Intent i = new Intent("com.nwd.action.ACTION_REQUEST_CHANGE_SOURCE");
        i.putExtra("extra_source_id", src);
        sendBroadcast(i);
        line("bcast ACTION_REQUEST_CHANGE_SOURCE extra_source_id=" + src);
    }
    private void sendExitFm() { sendBroadcast(new Intent("com.nwd.android.ACTION_EXIT_ARM_FM_RAIDO")); line("bcast ACTION_EXIT_ARM_FM_RAIDO"); }
    private void sendStopQqMusic() { sendBroadcast(new Intent("com.music.action.STOP_QQ_MUSIC")); line("bcast STOP_QQ_MUSIC (clear competing media)"); }

    private void tryVendorMediaPlayer() {
        try {
            if (vendorMp != null) { try { vendorMp.release(); } catch (Exception ignored) {} vendorMp = null; }
            vendorMp = new MediaPlayer();
            vendorMp.setAudioStreamType(android.media.AudioManager.STREAM_MUSIC);
            vendorMp.setDataSource("THIRDPARTY://MEDIAPLAYER_PLAYERTYPE_FM");
            vendorMp.prepare();
            vendorMp.start();
            line("vendor MediaPlayer prepared+started");
        } catch (Throwable e) { line("vendor MediaPlayer failed (expected on most units): " + e); }
    }

    // ── State snapshot / calibration ───────────────────────────────────────────
    private void calibrate() {
        if (radio == null) return;
        try {
            Frequency f = radio.getCurrentFrequency();
            if (f != null) { fmBand = f.band; int fv = f.freq; freqMult = fv > 50000 ? 1000 : fv > 5000 ? 100 : fv > 500 ? 10 : 1;
                line("calibrated freqMult=" + freqMult + " band=" + fmBand + " (from raw " + fv + ")"); }
        } catch (Exception e) { line("calibrate err " + e); }
    }

    private void snap(String tag) {
        StringBuilder s = new StringBuilder("SNAP[" + tag + "] src=" + readSource());
        if (radio != null) {
            try { s.append(" state=" + radio.getRadioState()); } catch (Exception e) { s.append(" state=err"); }
            try { Frequency f = radio.getCurrentFrequency(); if (f != null) s.append(" freq=" + f.freq + " PS='" + f.psName + "'"); } catch (Exception e) { s.append(" freq=err"); }
            try { s.append(" stereo=" + radio.isStreroOn()); } catch (Exception ignored) {}
            try { s.append(" rt='" + radio.getRtMessage() + "'"); } catch (Exception ignored) {}
            try { s.append(" backSvc=" + radio.isRadioBackServiceOn()); } catch (Exception ignored) {}
        } else s.append(" (not bound)");
        line(s.toString());
    }

    /** Current tuned frequency in MHz, or -1 if unavailable (uses the calibrated multiplier). */
    private double currentMhz() {
        if (radio == null) return -1;
        try { Frequency f = radio.getCurrentFrequency(); if (f != null && f.freq > 0) return f.freq / (double) freqMult; }
        catch (Exception ignored) {}
        return -1;
    }

    private int readSource() { try { return Settings.System.getInt(getContentResolver(), SRC_KEY, -1); } catch (Exception e) { return -1; } }

    private void startSourceObserver() {
        if (sourceObserver != null) return;
        sourceObserver = new ContentObserver(new Handler(Looper.getMainLooper())) {
            @Override public void onChange(boolean self) { line("OBS " + SRC_KEY + " -> " + readSource()); }
        };
        try { getContentResolver().registerContentObserver(Settings.System.getUriFor(SRC_KEY), false, sourceObserver); line("source observer on"); }
        catch (Exception e) { line("observer reg failed " + e); sourceObserver = null; }
    }

    private void startBroadcastLogger() {
        if (nwdRx != null) return;
        nwdRx = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                StringBuilder ex = new StringBuilder();
                Bundle b = i.getExtras();
                if (b != null) for (String k : b.keySet()) ex.append(k).append('=').append(b.get(k)).append(' ');
                line("BCAST " + i.getAction() + "  " + ex);
            }
        };
        IntentFilter f = new IntentFilter();
        for (String a : new String[]{
                "com.nwd.action.ACTION_APP_IN_OUT", "com.nwd.ACTION_MEDIA_PLAY",
                "com.nwd.action.ACTION_CHANGE_SOURCE", "com.nwd.action.ACTION_REQUEST_CHANGE_SOURCE",
                "com.nwd.action.ACTION_MCU_STATE_CHANGE", "com.nwd.android.ACTION_EXIT_ARM_FM_RAIDO",
                "com.nwd.radio.RDS" }) f.addAction(a);
        try {
            if (Build.VERSION.SDK_INT >= 34) registerReceiver(nwdRx, f, Context.RECEIVER_EXPORTED);
            else registerReceiver(nwdRx, f);
            line("broadcast logger on (" + f.countActions() + " actions)");
        } catch (Throwable e) { line("broadcast reg failed " + e); nwdRx = null; }
    }

    // ── Inline prompt primitive (called from the worker thread) ─────────────────
    /** Post a question with one button per option; block the worker until tapped.
     *  Buttons live in the activity's own view, so this survives leaving/returning
     *  to the app and never window-leaks. */
    private String prompt(String text, String... options) {
        line("Q: " + text.replace('\n', ' '));
        answer.clear();
        runOnUiThread(() -> {
            promptText.setText(text);
            promptButtons.removeAllViews();
            for (String opt : options) {
                Button b = new Button(this);
                b.setText(opt);
                b.setAllCaps(false);
                b.setOnClickListener(v -> {
                    answer.offer(opt);
                    promptButtons.removeAllViews();
                    promptText.setText("✓ " + opt);
                });
                b.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1f));
                promptButtons.addView(b);
            }
            promptPanel.setVisibility(View.VISIBLE);
        });
        try { String a = answer.take(); line("A: " + a); return a; }
        catch (InterruptedException e) { return ""; }
    }

    // ── Manual tune ────────────────────────────────────────────────────────────
    private void tuneMhz() { try { fmBand = (byte) Integer.parseInt(bandField.getText().toString().trim()); tuneMhzTo(Double.parseDouble(mhzField.getText().toString().trim())); } catch (Exception e) { line("bad MHz/band: " + e); } }
    private void tuneMhzTo(double mhz) {
        if (radio == null) { line("not connected"); return; }
        try { int raw = (int) Math.round(mhz * freqMult); line("tune " + mhz + " (raw " + raw + ", band " + fmBand + ")"); radio.setCurrentFrequency(raw, fmBand, 0); }
        catch (RemoteException e) { line("tune FAILED: " + e); }
    }

    // ── Callbacks (Binder thread) ─────────────────────────────────────────────
    private final RadioCallback.Stub callback = new RadioCallback.Stub() {
        public void notifyState(byte s) { line("cb state " + s); }
        public void notifyCurrentFrequency(byte band, int freq, String ps, int arg) { line("cb FREQ " + (freq / (double) freqMult) + " PS='" + ps + "' arg=" + arg); }
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
            if (Build.VERSION.SDK_INT >= 29) {
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
    private Button btn(String t, View.OnClickListener l) { Button b = new Button(this); b.setAllCaps(false); b.setText(t); b.setOnClickListener(l); return b; }
    private TextView label(String t) { TextView v = new TextView(this); v.setText(" " + t + " "); return v; }
    private View weighted(View v) { v.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1f)); return v; }
    private int dp(int v) { return (int) (v * getResources().getDisplayMetrics().density); }

    @Override protected void onDestroy() {
        try { if (vendorMp != null) { vendorMp.release(); vendorMp = null; } } catch (Exception ignored) {}
        try { if (sourceObserver != null) getContentResolver().unregisterContentObserver(sourceObserver); } catch (Exception ignored) {}
        try { if (nwdRx != null) unregisterReceiver(nwdRx); } catch (Exception ignored) {}
        try { if (radio != null) radio.unRegistCallback(callback); } catch (Exception ignored) {}
        try { unbindService(conn); } catch (Exception ignored) {}
        super.onDestroy();
    }
}
