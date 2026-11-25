import { describe, it, expect } from "vitest";
import { headway, scheduleFromDetail, scheduleFromTimetables } from "../src/schedule.js";

// Fixed instants, read in Madrid time (CET, UTC+1, in November).
const at = (hhmm) => new Date(`2026-11-25T${hhmm}:00+01:00`);

const detail = {
  stopId: "31",
  name: "Plaza Castilla",
  lines: [
    { line: "005", label: "5", direction: "A", from: "07:30", to: "23:30", dayType: "FE",
      headers: ["SOL/SEVILLA", "CHAMARTIN"], headway: { min: 18, max: 33 } },
    { line: "502", label: "N2", from: "23:40", to: "05:45", dayType: "FE",
      headers: [], headway: { min: 30, max: 35 } },
    { line: "999", label: "999", from: null, to: null, dayType: null, headers: [], headway: null },
  ],
};

describe("headway", () => {
  it("orders the band and ignores what EMT left blank", () => {
    expect(headway("33", "18")).toEqual({ min: 18, max: 33 });
    expect(headway("12", "0")).toEqual({ min: 12, max: 12 });
    expect(headway(undefined, "")).toBeNull();
  });
});

describe("scheduleFromDetail", () => {
  it("offers a typical and worst wait only while a line runs", () => {
    const [day, night, blank] = scheduleFromDetail(detail, at("12:00")).lines;
    expect(day).toMatchObject({ label: "5", state: "running", wait: { typical: 9, worst: 33 } });
    expect(night).toMatchObject({ state: "not_started", firstBus: "23:40", startsInMinutes: 700 });
    expect(night.wait).toBeUndefined();
    expect(blank.state).toBe("unknown");
  });

  it("runs a window that ends before it starts past midnight", () => {
    const lines = scheduleFromDetail(detail, at("02:00")).lines;
    expect(lines[0]).toMatchObject({ state: "not_started", firstBus: "07:30", startsInMinutes: 330 });
    expect(lines[1].state).toBe("running");
  });

  it("says a day line has ended after its last bus", () => {
    expect(scheduleFromDetail(detail, at("23:35")).lines[0])
      .toMatchObject({ state: "ended", firstBus: "07:30" });
  });

  it("reports EMT's own day type", () => {
    expect(scheduleFromDetail(detail, at("12:00"))).toMatchObject({ source: "stop", dayType: "FE" });
  });
});

describe("scheduleFromTimetables", () => {
  const timetables = [
    { line: "833", days: [{ dayType: "LA", from: "07:00", to: "20:30", overnight: false }] },
  ];

  it("borrows the line's hours for the day type asked", () => {
    const out = scheduleFromTimetables("30", timetables, "LA", at("08:00"));
    expect(out.source).toBe("line");
    expect(out.lines[0]).toMatchObject({ line: "833", borrowed: true, state: "running", headway: null });
  });

  it("treats a missing row as no service today, not as a gap", () => {
    expect(scheduleFromTimetables("30", timetables, "FE", at("08:00")).lines[0].state)
      .toBe("no_service_today");
  });
});
