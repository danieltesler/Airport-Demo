import { describe, expect, it } from "vitest";
import { createCharBudget, createSemaphore } from "./limits";

describe("createCharBudget", () => {
  it("allows spending up to the limit and refuses beyond it", () => {
    const budget = createCharBudget({ limit: 100, windowMs: 1000 });
    expect(budget.tryConsume("a", 60)).toBe(true);
    expect(budget.tryConsume("a", 40)).toBe(true);
    expect(budget.tryConsume("a", 1)).toBe(false);
  });

  it("counts each key separately", () => {
    const budget = createCharBudget({ limit: 100, windowMs: 1000 });
    expect(budget.tryConsume("a", 100)).toBe(true);
    expect(budget.tryConsume("b", 100)).toBe(true);
  });

  it("resets when the window passes", () => {
    let now = 0;
    const budget = createCharBudget({ limit: 100, windowMs: 1000, now: () => now });
    budget.tryConsume("a", 100);
    now = 1001;
    expect(budget.tryConsume("a", 100)).toBe(true);
  });

  it("gives characters back on refund, never below zero", () => {
    const budget = createCharBudget({ limit: 100, windowMs: 1000 });
    budget.tryConsume("a", 100);
    budget.refund("a", 70);
    expect(budget.tryConsume("a", 70)).toBe(true);
    budget.refund("a", 500);
    expect(budget.tryConsume("a", 100)).toBe(true);
  });

  it("does not grow without bound under many distinct keys", () => {
    const budget = createCharBudget({ limit: 10, windowMs: 1000 });
    for (let i = 0; i < 5000; i++) budget.tryConsume(`ip-${i}`, 1);
    // The oldest keys were dropped, so a fresh budget is granted again.
    expect(budget.tryConsume("ip-0", 10)).toBe(true);
  });
});

describe("createSemaphore", () => {
  it("lets up to max callers run and queues the rest in order", async () => {
    const semaphore = createSemaphore(2);
    const order: string[] = [];
    const releaseA = await semaphore.acquire();
    const releaseB = await semaphore.acquire();
    const third = semaphore.acquire().then((release) => {
      order.push("third");
      return release;
    });
    await Promise.resolve();
    expect(order).toEqual([]);

    releaseA();
    const releaseC = await third;
    expect(order).toEqual(["third"]);
    releaseB();
    releaseC();
  });

  it("frees the slot when everyone has released", async () => {
    const semaphore = createSemaphore(1);
    (await semaphore.acquire())();
    const release = await semaphore.acquire();
    expect(typeof release).toBe("function");
  });
});
