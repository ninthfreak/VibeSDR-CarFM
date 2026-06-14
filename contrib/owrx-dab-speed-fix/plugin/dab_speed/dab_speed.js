/*
 * dab_speed - OpenWebRX+ receiver plugin
 *
 * Workaround for the DAB/DAB+ "chipmunk" bug: some services play too fast/high
 * because dablin decodes them at their native rate (often 32 kHz or 24 kHz) but
 * the OpenWebRX+ Dablin chain reports a fixed 48 kHz, so the client plays them
 * 48000/realRate too fast.
 *
 * This plugin adds a "DAB Speed" selector to the DAB metadata panel and
 * time-stretches the HD audio by the chosen factor (only while a DAB service is
 * tuned), undoing the speedup. It touches no core files.
 *
 *   factor = realRate / 48000   ->   0.6667 = 32 kHz, 0.5 = 24 kHz
 *
 * Chosen factors are remembered per ensemble+programme in localStorage and
 * re-applied automatically when you return to that service.
 *
 * Install: drop this folder in htdocs/plugins/receiver/dab_speed/ and add
 *   Plugins.load('dab_speed');
 * to htdocs/plugins/receiver/init.js
 *
 * Provided by the VibeSDR project. Untested against every OWRX+ build - please
 * review/test before relying on it. The proper fix is server-side (see the
 * accompanying proper-fix/ notes).
 */

Plugins.dab_speed.no_css = true;

Plugins.dab_speed.factor = 1;          // current correction (1 = off)
Plugins.dab_speed._wrapped = false;
Plugins.dab_speed._store = {};         // { "<ensemble>|<programme>": factor }
Plugins.dab_speed._key = '';           // current station key

Plugins.dab_speed.PRESETS = [
  { v: 1,      l: 'Normal (48 kHz)' },
  { v: 0.6667, l: 'x0.67 (32 kHz)' },
  { v: 0.5,    l: 'x0.50 (24 kHz)' },
  { v: 0.3333, l: 'x0.33 (16 kHz)' },
  { v: 0.25,   l: 'x0.25 (12 kHz)' }
];

// Linear time-stretch an Int16Array by 1/factor (factor<1 => more samples = slower).
Plugins.dab_speed.stretch = function (buf, factor) {
  if (!factor || factor === 1 || !buf || buf.length === 0) return buf;
  var outLen = Math.max(1, Math.round(buf.length / factor));
  var out = new Int16Array(outLen);
  var step = (buf.length - 1) / (outLen - 1 || 1);
  for (var i = 0; i < outLen; i++) {
    var pos = i * step, i0 = pos | 0, i1 = Math.min(i0 + 1, buf.length - 1), t = pos - i0;
    out[i] = (buf[i0] * (1 - t) + buf[i1] * t) | 0;
  }
  return out;
};

// Are we currently demodulating DAB? (HD path is shared with HDR/WFM-HD.)
Plugins.dab_speed.isDab = function () {
  try {
    var d = (typeof UI !== 'undefined' && UI.getDemodulator) ? UI.getDemodulator() : null;
    return !!d && d.get_modulation && d.get_modulation() === 'dab';
  } catch (e) { return false; }
};

// Wrap the HD resampler's process() so DAB audio is stretched AFTER decode and
// BEFORE resampling to the sound-card rate. Polls until the engine exists.
Plugins.dab_speed._tryWrap = function () {
  if (Plugins.dab_speed._wrapped) return true;
  if (typeof audioEngine === 'undefined' || !audioEngine || !audioEngine.hdResampler) return false;
  var r = audioEngine.hdResampler;
  var orig = r.process.bind(r);
  r.process = function (buffer) {
    var self = Plugins.dab_speed;
    if (self.factor && self.factor !== 1 && self.isDab()) buffer = self.stretch(buffer, self.factor);
    return orig(buffer);
  };
  Plugins.dab_speed._wrapped = true;
  return true;
};

// Reflect the current factor in the dropdown.
Plugins.dab_speed._syncUI = function () {
  var sel = document.getElementById('dab-speed-select');
  if (sel) sel.value = String(Plugins.dab_speed.factor);
};

Plugins.dab_speed._applyFactor = function (f, persist) {
  Plugins.dab_speed.factor = (f > 0) ? f : 1;
  Plugins.dab_speed._syncUI();
  if (persist && Plugins.dab_speed._key) {
    Plugins.dab_speed._store[Plugins.dab_speed._key] = Plugins.dab_speed.factor;
    try { localStorage.setItem('dab_speed_store', JSON.stringify(Plugins.dab_speed._store)); } catch (e) {}
  }
};

// Build the selector and inject it into the DAB metadata panel. Appended INSIDE
// the .dab-container (below the programme picker) as its own full-width row, so
// it doesn't overlap the ensemble info.
Plugins.dab_speed._buildUI = function () {
  if ($('#dab-speed-select').length) return;
  var $container = $('#openwebrx-panel-metadata-dab .dab-container');
  var $target = $container.length ? $container : $('#openwebrx-panel-metadata-dab');
  if (!$target.length) return;
  var opts = Plugins.dab_speed.PRESETS.map(function (o) {
    return '<option value="' + o.v + '">' + o.l + '</option>';
  }).join('');
  var $wrap = $(
    '<div class="dab-speed-row" style="margin-top:10px;clear:both;">' +
      '<label for="dab-speed-select" style="display:block;margin-bottom:2px;">DAB Speed:</label>' +
      '<select id="dab-speed-select" style="width:100%;box-sizing:border-box;">' + opts + '</select>' +
    '</div>'
  );
  $wrap.find('#dab-speed-select').on('change', function () {
    Plugins.dab_speed._applyFactor(parseFloat($(this).val()), true);
  });
  $target.append($wrap);
  Plugins.dab_speed._syncUI();
};

// Track the tuned service from the DAB panel and auto-apply its saved factor.
Plugins.dab_speed._refreshStation = function () {
  var ens = $('#openwebrx-panel-metadata-dab .dab-ensemble-label').text() || '';
  var prog = $('#openwebrx-panel-metadata-dab #dab-service-id option:selected').text() || '';
  if (!prog) return;
  var key = ens + '|' + prog;
  if (key === Plugins.dab_speed._key) return;
  Plugins.dab_speed._key = key;
  Plugins.dab_speed._applyFactor(Plugins.dab_speed._store[key] || 1, false);
};

Plugins.dab_speed.init = function () {
  try {
    var saved = localStorage.getItem('dab_speed_store');
    if (saved) Plugins.dab_speed._store = JSON.parse(saved) || {};
  } catch (e) {}

  // Keep trying to wrap the resampler + build the UI as the engine/panel appear.
  var iv = setInterval(function () {
    Plugins.dab_speed._tryWrap();
    Plugins.dab_speed._buildUI();
    Plugins.dab_speed._refreshStation();
  }, 1000);
  // Stop polling for the wrap after a while, but keep refreshing the station via
  // a lighter interval (the panel selection/labels change as you tune).
  setTimeout(function () { clearInterval(iv); setInterval(Plugins.dab_speed._refreshStation, 1500); }, 30000);

  return true;
};
