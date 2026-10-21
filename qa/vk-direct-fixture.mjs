// This adapter-fixture transport owns its state separately from the official
// fake player. Real media/lifecycle behavior is verified in direct-audio tests.
export function installDirectFixture(window) {
  const control = { instances: [], loads: [], playCalls: 0, nextLoad: null, nextPlay: null, seeks: [] };
  window.__PULSE_CREATE_DIRECT_AUDIO__ = () => {
    let raw = null, playing = false, ended = false, generation = 0, position = 15, volume = .8;
    const result = {
      load: async value => { const epoch = ++generation; control.loads.push(value); const wait = control.nextLoad; control.nextLoad = null; if (wait) await wait; if (epoch !== generation) throw Object.assign(new Error('cancelled'), { code: 'PULSE_DIRECT_CANCELLED' }); raw = value; playing = false; ended = false; position = 0; },
      play: async () => { const epoch = generation; control.playCalls++; const wait = control.nextPlay; control.nextPlay = null; if (wait) await wait; if (epoch !== generation) throw Object.assign(new Error('cancelled'), { code: 'PULSE_DIRECT_CANCELLED' }); if (!raw) throw new Error('no loaded audio'); playing = true; ended = false; },
      pause: () => { generation++; playing = false; },
      stop: () => { generation++; raw = null; playing = false; ended = false; position = 0; },
      destroy: () => { generation++; raw = null; playing = false; },
      seek: value => { control.seeks.push(value); position = value; }, volume: value => { volume = value; },
      read: () => ({ playing, buffering: false, position, duration: raw ? Number(raw[5] || raw.duration || 60) : 0, ended, error: null }),
      end: () => { playing = false; ended = true; },
      get volumeValue() { return volume; },
    };
    control.instances.push(result);
    return result;
  };
  return control;
}
