// VibeSDR V4 — FT8 / FT4 decoder wrapper around ft8_lib (MIT).
#include "ft8_decoder.h"
#include <cmath>
#include <cstring>
#include <ctime>

extern "C" {
#include "ft8/decode.h"
#include "ft8/message.h"
#include "ft8/constants.h"
}

namespace vibe {

// ── Minimal callsign hashtable (for non-standard call resolution) ────────────
// ft8_lib needs a hash store so hashed callsigns ("<...>") can be resolved
// across messages. A small global table is fine — call hashes are global.
namespace {
struct HashEntry { char callsign[12]; uint32_t hash; };
constexpr int HT_MAX = 512;
HashEntry g_ht[HT_MAX] = {};

bool ht_lookup(ftx_callsign_hash_type_t type, uint32_t hash, char* callsign) {
    int shift = (type == FTX_CALLSIGN_HASH_10_BITS) ? 12
              : (type == FTX_CALLSIGN_HASH_12_BITS) ? 10 : 0;
    for (int i = 0; i < HT_MAX; i++) {
        if (g_ht[i].callsign[0] && (g_ht[i].hash >> shift) == hash) {
            std::strncpy(callsign, g_ht[i].callsign, 11);
            return true;
        }
    }
    callsign[0] = '\0';
    return false;
}
void ht_save(const char* callsign, uint32_t n22) {
    uint16_t h10 = (n22 >> 12) & 0x3FF;
    int idx = (h10 * 23) % HT_MAX;
    for (int n = 0; n < HT_MAX; n++) {
        int j = (idx + n) % HT_MAX;
        if (!g_ht[j].callsign[0] ||
            (g_ht[j].hash == n22 && std::strncmp(g_ht[j].callsign, callsign, 11) == 0)) {
            std::strncpy(g_ht[j].callsign, callsign, 11);
            g_ht[j].callsign[11] = '\0';
            g_ht[j].hash = n22;
            return;
        }
    }
}
ftx_callsign_hash_interface_t g_hashIf = { ht_lookup, ht_save };

constexpr int kMaxCandidates = 140;
constexpr int kMaxDecoded    = 50;
constexpr int kLdpcIters     = 25;
constexpr int kMinScore      = 10;
constexpr int kFreqOsr       = 2;
constexpr int kTimeOsr       = 2;
} // namespace

Ft8Decoder::Ft8Decoder(int sampleRate, bool ft4_)
    : ft4(ft4_), rate(sampleRate) {
    slotPeriod = ft4 ? FT4_SLOT_TIME : FT8_SLOT_TIME;
    capSamples = (int)(slotPeriod * rate);
    numSamples = (int)((slotPeriod - 0.4f) * rate);
    samples.assign(capSamples, 0.0f);

    monitor_config_t cfg = {};
    cfg.f_min = 100.0f;
    cfg.f_max = 3500.0f;
    cfg.sample_rate = rate;
    cfg.time_osr = kTimeOsr;
    cfg.freq_osr = kFreqOsr;
    cfg.protocol = ft4 ? FTX_PROTOCOL_FT4 : FTX_PROTOCOL_FT8;
    monitor_init(&mon, &cfg);
    ok = true;
}

Ft8Decoder::~Ft8Decoder() {
    if (ok) monitor_free(&mon);
}

void Ft8Decoder::process(const int16_t* in, int count) {
    if (!ok) return;

    // Slot alignment: wait until ~start of a UTC FT8/FT4 slot before buffering.
    if (!tsync) {
        const double timeShift = 0.8;
        struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);
        double now = (double)ts.tv_sec + ts.tv_nsec / 1e9;
        double within = std::fmod(now - timeShift, slotPeriod);
        if (within < 0) within += slotPeriod;
        if (within > slotPeriod / 4) return;   // not at a slot boundary yet
        inPos = framePos = 0;
        tsync = true;
    }

    for (int i = 0; i < count && inPos < capSamples; i++)
        samples[inPos++] = (float)in[i] / 32768.0f;

    int blk = mon.block_size;
    while (inPos >= framePos + blk && framePos < numSamples) {
        monitor_process(&mon, samples.data() + framePos);
        framePos += blk;
    }
    if (framePos < numSamples) return;

    runDecode();
    monitor_reset(&mon);
    tsync = false;
}

void Ft8Decoder::runDecode() {
    const ftx_waterfall_t* wf = &mon.wf;
    static ftx_candidate_t cands[kMaxCandidates];
    int n = ftx_find_candidates(wf, kMaxCandidates, cands, kMinScore);

    ftx_message_t decoded[kMaxDecoded];
    ftx_message_t* table[kMaxDecoded] = {};

    for (int idx = 0; idx < n; idx++) {
        const ftx_candidate_t* c = &cands[idx];
        ftx_message_t msg; ftx_decode_status_t st;
        if (!ftx_decode_candidate(wf, c, kLdpcIters, &msg, &st)) continue;

        // Dedupe identical payloads within this slot.
        int h = msg.hash % kMaxDecoded;
        bool dup = false, empty = false;
        do {
            if (!table[h]) { empty = true; }
            else if (table[h]->hash == msg.hash &&
                     std::memcmp(table[h]->payload, msg.payload, sizeof(msg.payload)) == 0) { dup = true; }
            else h = (h + 1) % kMaxDecoded;
        } while (!empty && !dup);
        if (dup) continue;
        decoded[h] = msg; table[h] = &decoded[h];

        char callTo[24] = {}, callDe[24] = {}, grid[24] = {};
        ftx_field_t fields[FTX_MAX_MESSAGE_FIELDS];
        ftx_message_rc_t rc = ftx_message_decode_std(&msg, &g_hashIf, callTo, callDe, grid, fields);
        if (rc != FTX_MESSAGE_RC_OK) continue;
        if (!callDe[0]) continue;

        float audioHz = (mon.min_bin + c->freq_offset + (float)c->freq_sub / wf->freq_osr) / mon.symbol_period;
        int snr = (int)std::lround(c->score * 0.5f - 24.0f);   // score→dB, rough offset
        if (onSpot) onSpot(callTo, callDe, grid, snr, audioHz);
    }
}

} // namespace vibe
