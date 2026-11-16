import type { CameraPath } from './types';

// Pose schedule for scenes with a moving camera. Frame j of a lap renders pose j % poses, so the
// measured views are the same whatever the frame rate and every pose is weighted equally.

/** Scene time of lap frame `frame`; wraps to 0 every `path.poses` frames. */
export const poseTime = (path: CameraPath, frame: number): number => ((frame % path.poses) * path.duration) / path.poses;

export type LapState = 'continue' | 'done' | 'abort';

/**
 * Whether measurement of a camera path stops after `n` frames over `elapsedMs`. It only stops on a
 * lap boundary: once the frame and time minimums are met, or when another lap would overrun
 * `maxMeasureMs`. A lap still unfinished at twice `maxMeasureMs` aborts the measurement.
 */
export function lapState(n: number, elapsedMs: number, poses: number, limits: { measureFrames: number; measureMs: number; maxMeasureMs: number }): LapState {
  if (n > 0 && n % poses === 0) {
    const laps = n / poses;
    if (n >= limits.measureFrames && elapsedMs >= limits.measureMs) return 'done';
    return (elapsedMs * (laps + 1)) / laps > limits.maxMeasureMs ? 'done' : 'continue';
  }
  return elapsedMs >= 2 * limits.maxMeasureMs ? 'abort' : 'continue';
}
