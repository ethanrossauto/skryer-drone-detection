// fft.h — minimal portable radix-2 complex FFT (host + Teensy fallback).
//
// This exists so the SRP-PHAT core in skryer_doa.cpp can be compiled and the
// algorithm validated on a laptop with g++ BEFORE any hardware is ordered.
//
// On the Teensy 4.0, swap this for CMSIS-DSP's arm_rfft_fast_f32 (real FFT,
// hand-tuned for the Cortex-M7 FPU) — it is ~5-10x faster than this generic
// radix-2 and halves the spectrum storage. See README.md -> "Porting to CMSIS".
// The portable version here still COMPILES on ARM, so the sketch builds and runs
// without CMSIS; it's just slower. The math is identical.
#pragma once
#include <complex>
#include <cmath>

namespace skryer {

// In-place radix-2 Cooley-Tukey FFT. n MUST be a power of two.
//   inverse=false : forward DFT (no scaling)
//   inverse=true  : inverse DFT (scaled by 1/n), so fft(fft(x)) == x
inline void fft(std::complex<float>* a, int n, bool inverse) {
    // Bit-reversal permutation.
    for (int i = 1, j = 0; i < n; ++i) {
        int bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) std::swap(a[i], a[j]);
    }
    // Butterflies.
    for (int len = 2; len <= n; len <<= 1) {
        float ang = 2.0f * float(M_PI) / float(len) * (inverse ? 1.0f : -1.0f);
        std::complex<float> wlen(std::cos(ang), std::sin(ang));
        for (int i = 0; i < n; i += len) {
            std::complex<float> w(1.0f, 0.0f);
            for (int k = 0; k < len / 2; ++k) {
                std::complex<float> u = a[i + k];
                std::complex<float> v = a[i + k + len / 2] * w;
                a[i + k] = u + v;
                a[i + k + len / 2] = u - v;
                w *= wlen;
            }
        }
    }
    if (inverse) {
        float inv = 1.0f / float(n);
        for (int i = 0; i < n; ++i) a[i] *= inv;
    }
}

}  // namespace skryer
