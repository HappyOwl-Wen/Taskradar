/** Browser fallback. The desktop window plays its alarm in Python, even while its WebView is hidden. */
export class BrowserAlarmSound {
  private context: AudioContext | null = null;
  private interval: number | undefined;
  private tones = new Set<OscillatorNode>();

  /** Unlock audio during a real gesture, e.g. the click that starts a focus session. */
  arm = () => {
    if (typeof AudioContext === "undefined") return;
    try {
      this.context ??= new AudioContext();
      void this.context.resume().catch(() => {});
    } catch {
      // A missing audio device must not affect the timer or its visual reminder.
    }
  };

  start() {
    if (this.interval !== undefined) return;
    this.chime();
    this.interval = window.setInterval(() => this.chime(), 2400);
  }

  private chime() {
    const context = this.context;
    if (!context || context.state !== "running") return;
    for (let i = 0; i < 3; i++) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const at = context.currentTime + i * 0.3;
      oscillator.type = "sine";
      oscillator.frequency.value = i === 1 ? 880 : 660;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.12, at + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.24);
      oscillator.connect(gain);
      gain.connect(context.destination);
      this.tones.add(oscillator);
      oscillator.onended = () => {
        this.tones.delete(oscillator);
        oscillator.disconnect();
        gain.disconnect();
      };
      oscillator.start(at);
      oscillator.stop(at + 0.25);
    }
  }

  stop() {
    window.clearInterval(this.interval);
    this.interval = undefined;
    for (const oscillator of this.tones) oscillator.stop();
    this.tones.clear();
  }

  dispose() {
    this.stop();
    const context = this.context;
    this.context = null;
    if (context) void context.close().catch(() => {});
  }
}
