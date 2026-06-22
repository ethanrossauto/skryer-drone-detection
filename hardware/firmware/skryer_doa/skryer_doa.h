// skryer_doa.h — on-node SRP-PHAT direction finding for the 4-mic array.
//
// C++ port of acoustic/doa.py, intended to run ON the Teensy 4.0 (600 MHz
// Cortex-M7 + FPU) so each node computes its own bearing and ships only ~a few
// bytes over the Heltec/Meshtastic LoRa mesh (see hardware/WIRING.md). The same
// source compiles on a laptop with g++ for validation (make test).
//
// Geometry and constants are kept IDENTICAL to acoustic/doa.py — if you change
// the array there, change it here too, or the bearings disagree.
#pragma once

namespace skryer {

constexpr float FS          = 44100.0f;  // Audio Library fixed sample rate (Hz)
constexpr float C_SOUND     = 343.0f;    // speed of sound (m/s) ~20 C
constexpr float D_SIDE      = 0.05f;     // square side length (m)
constexpr int   N_CH        = 4;         // mics / I2S-quad channels
constexpr int   N_PAIRS     = 6;         // N_CH*(N_CH-1)/2
constexpr float AZ_STEP_DEG = 2.0f;      // azimuth grid resolution (matches doa.py)
constexpr int   N_AZ        = 180;       // 360 / AZ_STEP_DEG

// Window == FFT size. Circular GCC-PHAT is fine because the true inter-mic delay
// (<= diagonal/c ~= 9 samples at 44.1 kHz) is tiny vs the window, and we only
// sample the cross-correlation at those small lags. 4096 is the max length
// CMSIS arm_rfft_fast_f32 supports, so this is the on-device ceiling too.
constexpr int   WINDOW      = 4096;

struct DoaResult {
    float az_deg;      // estimated azimuth [0,360)
    float el_deg;      // elevation (0 for the planar array)
    float score;       // peak SRP value
    float sharpness;   // peak / mean — >1.5 ~= a real source (matches doa.py)
};

// Build mic geometry + the (azimuth x pair) lag lookup table. Call once at boot.
void doa_init();

// Estimate bearing from N_CH channels of `n` float samples (n must == WINDOW).
// `ch[c]` points to channel c's samples. Does not modify the inputs.
DoaResult srp_phat(const float* const ch[N_CH], int n);

}  // namespace skryer
