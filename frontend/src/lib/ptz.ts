// Shared PTZ physical constants. The camera's *visual* slew (the green pointing ray in
// MapView) and the AUTO *confirm budget* (App.tsx) both derive from the same slew rate,
// so the ray arrives at a target right about when the zoom/ID phase begins.

// Effective slew rate of a cheap 20× PTZ under closed-loop visual servoing — settling-
// limited, deliberately conservative (its open-loop max would be higher).
export const SLEW_DEG_PER_S = 45;
