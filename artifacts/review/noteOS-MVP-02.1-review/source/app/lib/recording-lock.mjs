export function recordingLockName(noteId) {
  return `noteos:audio-recording:${encodeURIComponent(noteId)}`;
}

// A lock is held for the entire MediaRecorder session, including the final
// dataavailable write and status commit. No persisted owner token is trusted.
export async function acquireRecordingLock(locks, noteId) {
  if (!locks || typeof locks.request !== 'function') return { supported: false, release: null };

  let resolveReady, rejectReady, releaseHold;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const task = locks.request(recordingLockName(noteId), { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    resolveReady(Boolean(lock));
    if (lock) await new Promise((resolve) => { releaseHold = resolve; });
  });
  task.catch(rejectReady);

  const acquired = await ready;
  if (!acquired) {
    await task;
    return { supported: true, release: null };
  }
  let released = false;
  return {
    supported: true,
    release: async () => {
      if (released) return;
      released = true;
      releaseHold();
      await task;
    },
  };
}
