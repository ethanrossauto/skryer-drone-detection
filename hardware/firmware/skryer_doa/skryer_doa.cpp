// skryer_doa.cpp — SRP-PHAT implementation (see skryer_doa.h).
//
// Port of acoustic/doa.py. Pipeline per estimate:
//   1. FFT each of the 4 channels once.
//   2. For each of the 6 mic pairs: PHAT-weighted cross-spectrum -> inverse FFT
//      -> cross-correlation cc(lag).
//   3. Steer: for every candidate azimuth, sum each pair's cc sampled at that
//      direction's expected inter-mic delay; the azimuth with the largest sum
//      is the bearing.
#include "skryer_doa.h"
#include "fft.h"

#include <complex>
#include <cmath>

namespace skryer {

// Mic positions (metres): X=right, Y=forward, Z=up. Order = audio ch0..ch3.
// MUST match MIC_POSITIONS in acoustic/doa.py and the corners in WIRING.md.
static const float MIC_POS[N_CH][3] = {
    {+D_SIDE / 2, +D_SIDE / 2, 0.0f},  // ch0  front-right
    {-D_SIDE / 2, +D_SIDE / 2, 0.0f},  // ch1  front-left
    {-D_SIDE / 2, -D_SIDE / 2, 0.0f},  // ch2  back-left
    {+D_SIDE / 2, -D_SIDE / 2, 0.0f},  // ch3  back-right
};

// --- precomputed state (built by doa_init) -------------------------------
static int   PAIR_I[N_PAIRS], PAIR_J[N_PAIRS];
static float LAG_SAMPLES[N_AZ][N_PAIRS];   // expected TDOA per (azimuth, pair)
static bool  g_inited = false;

// --- scratch buffers (static => no per-call heap; lives in RAM) ----------
// On Teensy these total ~260 KB; place in DMAMEM/RAM2 if RAM1 is tight (README).
static std::complex<float> g_spec[N_CH][WINDOW];   // per-channel spectra
static std::complex<float> g_R[WINDOW];            // working cross-spectrum
static float               g_cc[N_PAIRS][WINDOW];  // cross-correlations

// Sample a circular cross-correlation at a (possibly negative, fractional) lag
// in samples, with linear interpolation and wraparound.
static inline float sample_cc(const float* cc, int n, float lag_samples) {
    float x = std::fmod(lag_samples, (float)n);
    if (x < 0.0f) x += (float)n;
    int i0 = (int)x;
    int i1 = (i0 + 1) % n;
    float f = x - (float)i0;
    return cc[i0] * (1.0f - f) + cc[i1] * f;
}

void doa_init() {
    int p = 0;
    for (int i = 0; i < N_CH; ++i)
        for (int j = i + 1; j < N_CH; ++j) { PAIR_I[p] = i; PAIR_J[p] = j; ++p; }

    for (int a = 0; a < N_AZ; ++a) {
        float az = (float)a * AZ_STEP_DEG * (float)M_PI / 180.0f;
        float dvec[3] = {std::cos(az), std::sin(az), 0.0f};  // elevation = 0
        for (int q = 0; q < N_PAIRS; ++q) {
            int i = PAIR_I[q], j = PAIR_J[q];
            float dot = 0.0f;
            for (int k = 0; k < 3; ++k) dot += (MIC_POS[i][k] - MIC_POS[j][k]) * dvec[k];
            // TDOA_ij = t_i - t_j for a far-field plane wave from direction dvec.
            LAG_SAMPLES[a][q] = (-dot / C_SOUND) * FS;
        }
    }
    g_inited = true;
}

DoaResult srp_phat(const float* const ch[N_CH], int n) {
    DoaResult res = {0.0f, 0.0f, 0.0f, 0.0f};
    if (!g_inited || n != WINDOW) return res;   // caller error; fail safe

    // 1. FFT each channel.
    for (int c = 0; c < N_CH; ++c) {
        for (int k = 0; k < n; ++k) g_spec[c][k] = std::complex<float>(ch[c][k], 0.0f);
        fft(g_spec[c], n, false);
    }

    // 2. PHAT cross-correlation per pair.
    for (int q = 0; q < N_PAIRS; ++q) {
        int i = PAIR_I[q], j = PAIR_J[q];
        for (int k = 0; k < n; ++k) {
            std::complex<float> r = g_spec[i][k] * std::conj(g_spec[j][k]);
            float mag = std::abs(r) + 1e-12f;   // PHAT: keep phase, flatten magnitude
            g_R[k] = r / mag;
        }
        fft(g_R, n, true);
        for (int k = 0; k < n; ++k) g_cc[q][k] = g_R[k].real();
    }

    // 3. Steered-response search over azimuth.
    float best = -1e30f;
    int   best_a = 0;
    double sum = 0.0;
    for (int a = 0; a < N_AZ; ++a) {
        float total = 0.0f;
        for (int q = 0; q < N_PAIRS; ++q)
            total += sample_cc(g_cc[q], n, LAG_SAMPLES[a][q]);
        sum += total;
        if (total > best) { best = total; best_a = a; }
    }

    float mean = (float)(sum / (double)N_AZ);
    res.az_deg    = (float)best_a * AZ_STEP_DEG;
    res.el_deg    = 0.0f;
    res.score     = best;
    res.sharpness = best / (mean + 1e-12f);
    return res;
}

}  // namespace skryer
