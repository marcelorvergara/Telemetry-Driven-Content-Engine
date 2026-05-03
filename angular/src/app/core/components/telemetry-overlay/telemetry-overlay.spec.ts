import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TelemetryOverlay } from './telemetry-overlay';

describe('TelemetryOverlay', () => {
  let component: TelemetryOverlay;
  let fixture: ComponentFixture<TelemetryOverlay>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TelemetryOverlay],
    }).compileComponents();

    fixture = TestBed.createComponent(TelemetryOverlay);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
