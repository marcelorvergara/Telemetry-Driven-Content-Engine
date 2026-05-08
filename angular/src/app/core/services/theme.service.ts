import { Injectable, signal } from '@angular/core';
import { ThemeConfig, VERGARA_YOUTUBE } from '../models/theme.model';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly currentTheme = signal<ThemeConfig>(VERGARA_YOUTUBE);

  setTheme(theme: ThemeConfig): void {
    this.currentTheme.set(theme);
  }

  updateMapAlpha(alpha: number): void {
    this.currentTheme.update(t => ({ ...t, map: { ...t.map, backgroundAlpha: alpha } }));
  }
}
