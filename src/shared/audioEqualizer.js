/* The same lazy DSP graph runs in the local UI and the private VK WebView. */
(() => {
  'use strict';
  const scope = globalThis;
  const frequencies = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const normalize = input => ({
    enabled: input?.enabled === true,
    bands: frequencies.map((_value, index) => typeof input?.bands?.[index] === 'number' && Number.isFinite(input.bands[index]) ? Math.max(-12, Math.min(12, input.bands[index])) : 0),
    preamp: typeof input?.preamp === 'number' && Number.isFinite(input.preamp) ? Math.max(-12, Math.min(0, input.preamp)) : 0,
  });
  function create(media, options = {}) {
    let graph = null;
    let destroyed = false;
    let settings = normalize(null);
    let preparedContext = null;
    let preparing = null;
    const newContext = () => {
      const Constructor = options.AudioContext || scope.AudioContext || scope.webkitAudioContext;
      if (!Constructor) throw new Error('Эквалайзер недоступен: Web Audio не поддерживается.');
      return new Constructor({ latencyHint: 'playback' });
    };
    function build() {
      const context = preparedContext || newContext();
      preparedContext = null;
      let source;
      try {
        // Allocate and configure the fallible processing nodes before taking
        // ownership of the media element's output (which is irreversible).
        const filters = frequencies.map(frequency => {
          const filter = context.createBiquadFilter();
          filter.type = 'peaking'; filter.frequency.value = Math.min(frequency, context.sampleRate * .49); filter.Q.value = 1.05; filter.gain.value = 0;
          return filter;
        });
        const gain = context.createGain();
        const limiter = context.createDynamicsCompressor();
        limiter.threshold.value = -2; limiter.knee.value = 3; limiter.ratio.value = 20; limiter.attack.value = .002; limiter.release.value = .08;
        for (let index = 1; index < filters.length; index++) filters[index - 1].connect(filters[index]);
        filters.at(-1).connect(gain); gain.connect(limiter); limiter.connect(context.destination);
        source = context.createMediaElementSource(media); source.connect(filters[0]);
        graph = { context, source, filters, gain, limiter };
      } catch (error) {
        try { source?.disconnect(); } catch { /* teardown */ }
        try { void context.close().catch(() => {}); } catch { /* teardown */ }
        throw new Error('Эквалайзер недоступен для этого источника звука.');
      }
    }
    const smooth = (param, value, at, initial = false) => {
      param.cancelScheduledValues(at);
      if (initial) param.setValueAtTime(value, at);
      else { param.setValueAtTime(param.value, at); param.setTargetAtTime(value, at, .025); }
    };
    function apply(input) {
      if (destroyed) return;
      settings = normalize(input);
      if (!settings.enabled && !graph) return;
      const initial = !graph;
      if (!graph) build();
      const { context, filters, gain, limiter } = graph;
      const at = context.currentTime;
      // Compression is only needed when positive shelves/peaks can create
      // overload. A preamp-only cut and flat profile must remain bit-level
      // neutral apart from their intentional gain change.
      const neutral = !settings.enabled || !settings.bands.some(band => band > 0);
      // Measure the combined response, including overlap between adjacent
      // bands. The limiter handles remaining transient peaks conservatively.
      const points = new Float32Array(1024);
      const response = new Float64Array(points.length).fill(1);
      for (let index = 0; index < points.length; index++) points[index] = 10 * Math.pow(Math.min(22000, context.sampleRate * .499) / 10, index / (points.length - 1));
      for (let index = 0; index < filters.length; index++) {
        const filter = filters[index], next = settings.enabled ? settings.bands[index] : 0;
        // Evaluate the RBJ peaking coefficients separately so automation on
        // audible AudioParams is never cancelled just to measure headroom.
        const amplitude = Math.pow(10, next / 40), omega = 2 * Math.PI * filter.frequency.value / context.sampleRate;
        const alpha = Math.sin(omega) / (2 * filter.Q.value), cosine = Math.cos(omega);
        const numerator = [1 + alpha * amplitude, -2 * cosine, 1 - alpha * amplitude];
        const denominator = [1 + alpha / amplitude, -2 * cosine, 1 - alpha / amplitude];
        for (let point = 0; point < response.length; point++) {
          const angle = 2 * Math.PI * points[point] / context.sampleRate;
          const c1 = Math.cos(angle), c2 = Math.cos(2 * angle), s1 = Math.sin(angle), s2 = Math.sin(2 * angle);
          const magnitude = coefficients => Math.hypot(coefficients[0] + coefficients[1] * c1 + coefficients[2] * c2, coefficients[1] * s1 + coefficients[2] * s2);
          const ratio = magnitude(numerator) / magnitude(denominator);
          response[point] *= Number.isFinite(ratio) ? ratio : 1;
        }
        smooth(filter.gain, next, at, initial);
      }
      const peak = Math.max(1, ...response);
      const margin = settings.enabled && settings.bands.some(band => band > 0) ? Math.pow(10, -.5 / 20) : 1;
      smooth(gain.gain, settings.enabled ? Math.pow(10, settings.preamp / 20) * margin / peak : 1, at, initial);
      // Disabling smoothly returns the connected graph to an exact flat
      // path; disconnecting a MediaElementSource cannot restore native audio.
      smooth(limiter.threshold, neutral ? 0 : -2, at, initial);
      smooth(limiter.ratio, neutral ? 1 : 20, at, initial);
      smooth(limiter.knee, neutral ? 0 : 3, at, initial);
    }
    return {
      apply,
      async prepare() {
        if (destroyed || graph) return;
        if (!preparing) {
          preparedContext = newContext();
          const context = preparedContext;
          preparing = (async () => {
            // Resume before capturing the media element output. Browsers may
            // reject autoplay on AudioContext even while native Audio works.
            if (context.state === 'suspended') await context.resume();
            if (destroyed || context.state !== 'running') throw new Error('Эквалайзер не запустился.');
          })();
        }
        await preparing;
      },
      async resume() {
        if (destroyed || !graph) return;
        if (graph.context.state === 'suspended') await graph.context.resume();
        if (!destroyed && graph.context.state !== 'running') throw new Error('Эквалайзер не запустился. Повторите воспроизведение.');
      },
      get active() { return !destroyed && Boolean(graph) && settings.enabled; },
      get connected() { return !destroyed && Boolean(graph); },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        if (preparedContext) { try { void preparedContext.close().catch(() => {}); } catch { /* teardown */ } preparedContext = null; }
        if (!graph) return;
        const previous = graph; graph = null;
        for (const node of [previous.source, ...previous.filters, previous.gain, previous.limiter]) { try { node.disconnect(); } catch { /* teardown */ } }
        try { void previous.context.close().catch(() => {}); } catch { /* teardown */ }
      },
    };
  }
  Object.defineProperty(scope, '__PULSE_CREATE_EQUALIZER__', { value: create, configurable: true });
})();
