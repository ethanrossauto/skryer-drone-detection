# Host build of the SRP-PHAT core for validation before ordering hardware.
# `make test` proves the C++ port recovers known bearings (mirrors doa.py).
CXX      ?= g++
CXXFLAGS ?= -O2 -std=c++17 -Wall -Wextra

selftest: selftest.cpp skryer_doa.cpp skryer_doa.h fft.h
	$(CXX) $(CXXFLAGS) selftest.cpp skryer_doa.cpp -o selftest

test: selftest
	./selftest

clean:
	rm -f selftest

.PHONY: test clean
