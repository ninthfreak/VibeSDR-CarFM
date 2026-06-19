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

void StereoPLL::step(float mpx, float* ref38, float* ref57) {
    const double s = std::sin(phase_);
    const double c = std::cos(phase_);
    // Phase detector: pilot * quadrature. When locked, cos(phase) aligns with the
    // pilot, so the error is mpx * (-sin) averaged.
    const double err = (double)mpx * (-s);
    dphase_ += beta_ * err;
    phase_  += dphase_ + alpha_ * err;
    if (phase_ > 2.0 * M_PI) phase_ -= 2.0 * M_PI;
    else if (phase_ < 0.0)   phase_ += 2.0 * M_PI;

    // Lock metric: smoothed in-phase pilot energy (mpx correlated with cos).
    lockAmp_ += 0.0005f * ((float)(mpx * c) * 2.0f - lockAmp_);

    // Phase-coherent harmonics via angle doubling/tripling.
    if (ref38) *ref38 = (float)std::cos(2.0 * phase_);
    if (ref57) *ref57 = (float)std::cos(3.0 * phase_);
}

} // namespace vibedsp
