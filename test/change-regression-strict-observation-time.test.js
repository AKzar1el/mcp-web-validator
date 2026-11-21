import assert from "node:assert/strict";
import test from "node:test";
import { strictObservationTime } from
  "../dist/modules/change-regression/strict-observation-time.js";

test("ISO observation timestamps reject normalized impossible dates and invalid clock/offset fields", () => {
  const invalid = [
    "2026-02-30T09:00:00Z", "2025-02-29T09:00:00Z",
    "1900-02-29T09:00:00Z", "2026-04-31T09:00:00Z",
    "2026-00-01T09:00:00Z", "2026-13-01T09:00:00Z",
    "2026-01-00T09:00:00Z", "2026-01-32T09:00:00Z",
    "2026-11-21T24:00:00Z", "2026-11-21T09:60:00Z",
    "2026-11-21T09:00:60Z", "2026-11-21T09:00:00+24:00",
    "2026-11-21T09:00:00+02:60",
    "2026-11-21T09:00:00", "2026-11-21", "2026-11-21T09:00Z",
    "2026-11-21T09:00:00.0000Z",
    "2026-11-21T09:00:00z", "2026-11-21T09:00:00+02",
    "", "not a timestamp", null, 1234,
  ];
  for(const value of invalid){
    assert.equal(strictObservationTime(value),undefined,JSON.stringify(value));
  }
});

test("ISO observation timestamps preserve real leap days and offset-normalized instant", () => {
  for(const value of [
    "2000-02-29T00:00:00Z", "2024-02-29T23:59:59.123Z",
    "2026-11-21T09:30:00+05:30", "2026-11-21T09:30:00-08:00",
    "2026-11-21T09:30:00.7Z", "9999-12-31T23:59:59Z",
  ]){
    assert.equal(strictObservationTime(value),Date.parse(value),value);
  }
});

test("calendar boundaries 1900-2100 are consistent for all 12 months and 35 day candidates", () => {
  for(const year of [1900,2000,2024,2025,2026,2100]){
    const leap=year%4===0&&(year%100!==0||year%400===0);
    const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
    for(let month=1;month<=12;month++){
      for(let day=1;day<=35;day++){
        const value=`${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}T12:00:00Z`;
        assert.equal(strictObservationTime(value)!==undefined,day<=days[month-1],value);
      }
    }
  }
});
