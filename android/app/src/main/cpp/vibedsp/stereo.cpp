// VibeSDR V5 — FM stereo pilot PLL. Original VibeSDR code.
#include "vibedsp.h"
#include <cmath>

namespace vibedsp {

void StereoPLL::configure(double pilotHz, double rate) {
    w0_ = 2.0 * M_PI * pilotHz / rate;
    dphase_ = w0_;
    phase_ = 0.0;
    // Second-order loop. Modest bandwidth (~one-thousandth of rate) for a clean
    // lock on the narrow pilot without excessive jitter.
    const double bw = w0_ * 0.01;            // loop bandwidth (rad/sample)
    const double zeta = 0.707;
    alpha_ = 2.0 * zeta * bw;
    beta_  = bw * bw;
    lockAmp_ = 0.0f;
}

void StereoPLL::step(float mpx, float* ref38, float* ref57, float* bitClk) {
    const double s = std::sin(phase_);
    const double c = std::cos(phase_);
    // Phase detector: pilot * quadrature. When locked, cos(phase) aligns with the
    // pilot, so the error is mpx * (-sin) averaged.
    const double err = (double)mpx * (-s);
    dphase_ += beta_ * err;
    phase_  += dphase_ + alpha_ * err;
    if (phase_ >= 2.0 * M_PI) { phase_ -= 2.0 * M_PI; cycle_ = (cycle_ + 1) & 15; }
    else if (phase_ < 0.0)    { phase_ += 2.0 * M_PI; cycle_ = (cycle_ + 15) & 15; }

    // Lock metric: smoothed in-phase pilot energy (mpx correlated with cos).
    lockAmp_ += 0.0005f * ((float)(mpx * c) * 2.0f - lockAmp_);

    // Phase-coherent references from the base sin/cos via exact angle identities
    // (no extra trig). The PLL locks cos(phase) onto the SINE pilot, so the L-R
    // subcarrier — sin(2*pilot) per the FM stereo standard — is in phase with
    // -sin(2*phase) = -2*s*c (NOT cos(2*phase), which is quadrature -> cancels the
    // whole difference signal). RDS keeps cos(3*phase): its bi-phase decoder is
    // phase-tolerant, so it already works.
    if (ref38) *ref38 = (float)(-2.0 * s * c);              // -sin(2*phase)
    if (ref57) *ref57 = (float)(c * (4.0 * c * c - 3.0));   // cos(3*phase)
    // RDS bit clock (1187.5 Hz = pilot/16) derived directly from the pilot phase
    // + cycle counter, so it inherits the PLL's stability without integral drift.
    if (bitClk) *bitClk = (float)((cycle_ * 2.0 * M_PI + phase_) / 16.0);
}

} // namespace vibedsp
