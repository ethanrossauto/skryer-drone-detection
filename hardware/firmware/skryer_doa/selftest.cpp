// selftest.cpp — host validation of the C++ SRP-PHAT port (no hardware).
//
// Mirrors acoustic/doa.py --selftest: synthesize a far-field plane wave from a
// known azimuth (white-noise source, fractional per-mic delay, additive noise),
// run srp_phat, and check the recovered bearing. PASS == worst error within
// 2x the azimuth grid step, the same bar doa.py uses.
//
// Build + run:  make test     (or: g++ -O2 -std=c++17 selftest.cpp skryer_doa.cpp -o selftest && ./selftest)
//
// Guarded out of the Arduino build (the sketch provides setup()/loop()).
#ifndef ARDUINO

#include "skryer_doa.h"
#include "fft.h"

#include <complex>
#include <vector>
#include <random>
#include <chrono>
#include <cmath>
#include <cstdio>

using namespace skryer;

// Same geometry as skryer_doa.cpp (kept local to the synth so the test is
// self-contained — if one changes, the test would (correctly) start failing).
static const float MP[N_CH][3] = {
    {+D_SIDE / 2, +D_SIDE / 2, 0.0f},
    {-D_SIDE / 2, +D_SIDE / 2, 0.0f},
    {-D_SIDE / 2, -D_SIDE / 2, 0.0f},
    {+D_SIDE / 2, -D_SIDE / 2, 0.0f},
};

// Shift a real signal by d samples (fractional, can be negative) via FFT phase
// ramp — the same trick as doa.py's _frac_delay.
static void frac_delay(std::vector<float>& x, float d_samples) {
    int n = (int)x.size();
    std::vector<std::complex<float>> X(n);
    for (int i = 0; i < n; ++i) X[i] = std::complex<float>(x[i], 0.0f);
    fft(X.data(), n, false);
    for (int k = 0; k < n; ++k) {
        int kk = (k <= n / 2) ? k : k - n;          // signed frequency bin
        float ang = -2.0f * (float)M_PI * (float)kk * d_samples / (float)n;
        X[k] *= std::complex<float>(std::cos(ang), std::sin(ang));
    }
    fft(X.data(), n, true);
    for (int i = 0; i < n; ++i) x[i] = X[i].real();
}

static void synth(float az_deg, float snr_db, unsigned seed,
                  std::vector<std::vector<float>>& chans) {
    const int n = WINDOW;
    std::mt19937 rng(seed);
    std::normal_distribution<float> g(0.0f, 1.0f);

    std::vector<float> base(n);
    for (int i = 0; i < n; ++i) base[i] = g(rng);

    float az = az_deg * (float)M_PI / 180.0f;
    float dvec[3] = {std::cos(az), std::sin(az), 0.0f};

    double mean = 0.0;
    for (float v : base) mean += v;
    mean /= n;
    double var = 0.0;
    for (float v : base) var += (v - mean) * (v - mean);
    var /= n;
    float noise_std = (float)std::sqrt(var / std::pow(10.0, snr_db / 10.0));

    chans.assign(N_CH, std::vector<float>(n));
    for (int c = 0; c < N_CH; ++c) {
        float dot = 0.0f;
        for (int k = 0; k < 3; ++k) dot += MP[c][k] * dvec[k];
        float tau = -dot / C_SOUND;                 // arrival time at mic c (s)
        std::vector<float> sig = base;
        frac_delay(sig, tau * FS);
        for (int i = 0; i < n; ++i) chans[c][i] = sig[i] + g(rng) * noise_std;
    }
}

int main() {
    doa_init();
    printf("Skryer C++ DoA self-test (host build, float32 — mirrors acoustic/doa.py)\n");
    printf("array=5cm square, NFFT=%d (circular GCC-PHAT), az grid %.1f deg\n\n",
           WINDOW, AZ_STEP_DEG);

    const int azs[] = {0, 45, 90, 135, 180, 225, 270, 315};
    float worst = 0.0f;
    for (int a : azs) {
        std::vector<std::vector<float>> chans;
        synth((float)a, 20.0f, (unsigned)a, chans);
        const float* ptr[N_CH] = {chans[0].data(), chans[1].data(),
                                  chans[2].data(), chans[3].data()};
        DoaResult r = srp_phat(ptr, WINDOW);
        float err = std::fabs(std::fmod(r.az_deg - (float)a + 540.0f, 360.0f) - 180.0f);
        worst = std::max(worst, err);
        printf("  true az=%3d  ->  est az=%6.1f  err=%4.1f deg  sharpness=%5.2f\n",
               a, r.az_deg, err, r.sharpness);
    }
    bool pass = worst <= 2.0f * AZ_STEP_DEG;
    printf("\nworst error: %.1f deg  (%s)\n", worst, pass ? "PASS" : "CHECK geometry/grid");

    // --- compute budget --------------------------------------------------
    std::vector<std::vector<float>> chans;
    synth(90.0f, 20.0f, 123u, chans);
    const float* ptr[N_CH] = {chans[0].data(), chans[1].data(),
                              chans[2].data(), chans[3].data()};
    const int iters = 50;
    volatile float sink = 0.0f;
    auto t0 = std::chrono::high_resolution_clock::now();
    for (int it = 0; it < iters; ++it) { DoaResult r = srp_phat(ptr, WINDOW); sink += r.az_deg; }
    auto t1 = std::chrono::high_resolution_clock::now();
    double us = std::chrono::duration_cast<std::chrono::nanoseconds>(t1 - t0).count()
                / 1000.0 / iters;

    printf("\nper-estimate compute (this host, portable radix-2 FFT): %.0f us\n", us);
    printf("  work = %dx %d-pt fwd FFT + %dx inv FFT + %dx%d grid steer\n",
           N_CH, WINDOW, N_PAIRS, N_AZ, N_PAIRS);
    printf("  window covers %.0f ms of audio -> need < %.0f ms/estimate for real time\n",
           1000.0 * WINDOW / FS, 1000.0 * WINDOW / FS);
    printf("  NOTE: Teensy 4.0 with CMSIS arm_rfft_fast_f32 is far faster per FFT than\n");
    printf("        this generic host FFT; see README.md -> Feasibility for the M7 budget.\n");

    return pass ? 0 : 1;
}

#endif  // !ARDUINO
