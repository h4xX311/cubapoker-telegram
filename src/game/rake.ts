export interface RakeConfig {
  percentage: number;
  maxRake: number;
  minPot: number;
}

const DEFAULT_CONFIG: RakeConfig = {
  percentage: 5,
  maxRake: 100,
  minPot: 10,
};

export class RakeManager {
  private config: RakeConfig;

  constructor(config: Partial<RakeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  calculateRake(pot: number): number {
    if (pot < this.config.minPot) return 0;
    const rake = Math.floor((pot * this.config.percentage) / 100);
    return Math.min(rake, this.config.maxRake);
  }

  splitPot(pot: number): { rake: number; netPot: number } {
    const rake = this.calculateRake(pot);
    return { rake, netPot: pot - rake };
  }

  getConfig(): RakeConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<RakeConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
