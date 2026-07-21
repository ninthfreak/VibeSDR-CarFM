package com.ninthfreak.nwdprobe;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.media.AudioManager;
import android.os.Bundle;
import android.os.IBinder;
import android.os.RemoteException;
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

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Proof-of-life probe for the head unit's built-in FM tuner (com.nwd.radio.service).
 * Binds the service, tunes, and logs RDS — and takes a swing at the audio-source
 * switch. This is a throwaway test harness, NOT the CarFM backend. See README.
 */
public class MainActivity extends Activity {

    private static final String BIND_ACTION = "com.nwd.radio.service.ACTION_RADIO_SERVICE";
    private static final String SERVICE_PKG = "com.nwd.radio.service";

    private RadioFeature radio;
    private TextView log;
    private EditText mhzField, bandField;
    private int freqMult = 1000;   // MHz -> raw multiplier, auto-detected on connect
    private byte fmBand = 0;       // band byte, auto-detected on connect

    // ── UI ────────────────────────────────────────────────────────────────────
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(10);
        root.setPadding(pad, pad, pad, pad);

        root.addView(btn("1. CONNECT", v -> connect()));

        LinearLayout tuneRow = new LinearLayout(this);
        tuneRow.setOrientation(LinearLayout.HORIZONTAL);
        mhzField = new EditText(this); mhzField.setText("88.7");
        mhzField.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 2f));
        bandField = new EditText(this); bandField.setText("0");
        bandField.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1f));
        tuneRow.addView(label("MHz")); tuneRow.addView(mhzField);
        tuneRow.addView(label("band")); tuneRow.addView(bandField);
        root.addView(tuneRow);

        LinearLayout tuneBtns = new LinearLayout(this);
        tuneBtns.setOrientation(LinearLayout.HORIZONTAL);
        tuneBtns.addView(weighted(btn("TUNE (MHz)", v -> tuneMhz())));
        tuneBtns.addView(weighted(btn("TUNE (raw)", v -> tuneRaw())));
        root.addView(tuneBtns);

        LinearLayout seekRow = new LinearLayout(this);
        seekRow.setOrientation(LinearLayout.HORIZONTAL);
        seekRow.addView(weighted(btn("SEEK ▼", v -> seek(false))));
        seekRow.addView(weighted(btn("SEEK ▲", v -> seek(true))));
        seekRow.addView(weighted(btn("READ STATE", v -> readState())));
        root.addView(seekRow);

        LinearLayout audioRow = new LinearLayout(this);
        audioRow.setOrientation(LinearLayout.HORIZONTAL);
        audioRow.addView(weighted(btn("2. AUDIO ON", v -> audioOn())));
        audioRow.addView(weighted(btn("AUDIO OFF", v -> audioOff())));
        audioRow.addView(weighted(btn("RDS ON", v -> rdsOn())));
        root.addView(audioRow);

        log = new TextView(this);
        log.setTextSize(11f);
        log.setMovementMethod(new ScrollingMovementMethod());
        log.setTypeface(android.graphics.Typeface.MONOSPACE);
        ScrollView sv = new ScrollView(this);
        sv.addView(log);
        root.addView(sv);

        setContentView(root);
        line("Ready. Tap CONNECT. (Watch logcat too: adb logcat | grep -i nwdprobe)");
    }

    // ── Binding ─────────────────────────────────────────────────────────────
    private void connect() {
        Intent i = new Intent(BIND_ACTION);
        i.setPackage(SERVICE_PKG);
        boolean ok = bindService(i, conn, Context.BIND_AUTO_CREATE);
        line("bindService(" + BIND_ACTION + ") returned " + ok
                + (ok ? "" : "  <-- FALSE = service not found / not bindable"));
    }

    private final ServiceConnection conn = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            radio = RadioFeature.Stub.asInterface(binder);
            line("CONNECTED to " + name.flattenToShortString());
            try {
                radio.registCallback(callback);
                line("registCallback OK");
            } catch (RemoteException e) { line("registCallback FAILED: " + e); }
            readState();
        }
        @Override public void onServiceDisconnected(ComponentName name) {
            radio = null; line("DISCONNECTED");
        }
    };

    // ── Actions ─────────────────────────────────────────────────────────────
    private void readState() {
        if (radio == null) { line("not connected"); return; }
        try {
            line("radioType=" + radio.getRadioType() + " state=" + radio.getRadioState()
                    + " scanState=" + radio.getCurrentScanState() + " stereo=" + radio.isStreroOn());
            Frequency f = radio.getCurrentFrequency();
            if (f != null) {
                line("getCurrentFrequency -> " + f);
                fmBand = f.band;
                bandField.setText(String.valueOf((int) f.band));
                // auto-detect MHz->raw multiplier from the current raw value magnitude
                int fv = f.freq;
                freqMult = fv > 50000 ? 1000 : fv > 5000 ? 100 : fv > 500 ? 10 : 1;
                line("  detected: band=" + f.band + "  freqMult=" + freqMult
                        + " (so " + (fv / (double) freqMult) + " MHz)  PS='" + f.psName + "'");
            }
            RadioPoint[] pts = radio.getRadioPoint();
            if (pts != null) for (RadioPoint p : pts) line("getRadioPoint -> " + p + " (min/max/step, some order)");
            line("getRtMessage -> '" + radio.getRtMessage() + "'");
        } catch (RemoteException e) { line("readState FAILED: " + e); }
    }

    private void tuneMhz() {
        try {
            double mhz = Double.parseDouble(mhzField.getText().toString().trim());
            int raw = (int) Math.round(mhz * freqMult);
            tune(raw);
        } catch (Exception e) { line("bad MHz: " + e); }
    }

    private void tuneRaw() {
        try { tune((int) Math.round(Double.parseDouble(mhzField.getText().toString().trim()))); }
        catch (Exception e) { line("bad raw: " + e); }
    }

    private void tune(int raw) {
        if (radio == null) { line("not connected"); return; }
        byte band = parseByte(bandField.getText().toString(), fmBand);
        try {
            line("setCurrentFrequency(freq=" + raw + ", band=" + band + ", flag=0)");
            radio.setCurrentFrequency(raw, band, 0);
        } catch (RemoteException e) { line("tune FAILED: " + e); }
    }

    private void seek(boolean up) {
        if (radio == null) { line("not connected"); return; }
        try { radio.seek(up); line("seek(" + (up ? "up" : "down") + ")"); }
        catch (RemoteException e) { line("seek FAILED: " + e); }
    }

    private void rdsOn() {
        if (radio == null) { line("not connected"); return; }
        try {
            // selector byte is a guess (0). RDS may already be on; callbacks/getRtMessage tell.
            radio.setRDSState((byte) 0, true);
            line("setRDSState(0,true); getRDSState(0)=" + radio.getRDSState(0)
                    + "  rt='" + radio.getRtMessage() + "'");
        } catch (RemoteException e) { line("rdsOn FAILED: " + e); }
    }

    /**
     * EXPERIMENTAL: try to make FM audio come out. FM audio is analog, MCU-routed
     * to the amp on STREAM_MUSIC; to hear it we must become the active audio
     * source. Exact extras are unknown, so this fires the candidate source-switch
     * broadcasts + setRadioBackServiceOn(true) + unmutes music. Report what happens.
     */
    private void audioOn() {
        try { if (radio != null) { radio.setRadioBackServiceOn(true); line("setRadioBackServiceOn(true)"); } }
        catch (RemoteException e) { line("setRadioBackServiceOn FAILED: " + e); }
        sendBroadcast(new Intent("com.nwd.action.ACTION_REQUEST_CHANGE_SOURCE"));
        sendBroadcast(new Intent("com.nwd.action.ACTION_CHANGE_SOURCE"));
        sendBroadcast(new Intent("com.nwd.action.ACTION_REQUEST_GOTO_CURRENT_SOURCE"));
        line("broadcast ACTION_(REQUEST_)CHANGE_SOURCE (no extras — experimental)");
        AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
        if (am != null) {
            am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_UNMUTE, 0);
            line("unmuted STREAM_MUSIC");
        }
        line(">>> Did you hear the station? (If not, audio is likely gated to the stock app.)");
    }

    private void audioOff() {
        try { if (radio != null) radio.setRadioBackServiceOn(false); } catch (RemoteException ignored) {}
        line("setRadioBackServiceOn(false)");
    }

    // ── Callbacks (Binder thread) ─────────────────────────────────────────────
    private final RadioCallback.Stub callback = new RadioCallback.Stub() {
        public void notifyState(byte s) { line("cb notifyState " + s); }
        public void notifyCurrentFrequency(byte band, int freq, String ps, int arg) {
            line("cb FREQ band=" + band + " freq=" + freq + " (" + (freq / (double) freqMult) + " MHz) PS='" + ps + "' arg=" + arg);
        }
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

    // ── helpers ───────────────────────────────────────────────────────────────
    private static byte parseByte(String s, byte dflt) {
        try { return (byte) Integer.parseInt(s.trim()); } catch (Exception e) { return dflt; }
    }
    private final SimpleDateFormat ts = new SimpleDateFormat("HH:mm:ss", Locale.US);
    private void line(final String s) {
        android.util.Log.i("nwdprobe", s);
        runOnUiThread(() -> {
            log.append(ts.format(new Date()) + "  " + s + "\n");
            final int amount = log.getLayout() == null ? 0
                    : log.getLayout().getLineTop(log.getLineCount()) - log.getHeight();
            if (amount > 0) log.scrollTo(0, amount);
        });
    }
    private Button btn(String t, View.OnClickListener l) { Button b = new Button(this); b.setText(t); b.setOnClickListener(l); return b; }
    private TextView label(String t) { TextView v = new TextView(this); v.setText(" " + t + " "); return v; }
    private View weighted(View v) { v.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1f)); return v; }
    private int dp(int v) { return (int) (v * getResources().getDisplayMetrics().density); }

    @Override protected void onDestroy() {
        try { if (radio != null) radio.unRegistCallback(callback); } catch (Exception ignored) {}
        try { unbindService(conn); } catch (Exception ignored) {}
        super.onDestroy();
    }
}
