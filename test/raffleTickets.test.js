const test = require("node:test");
const assert = require("node:assert/strict");
const { splitRaffleTickets } = require("../utils/raffleTickets");

test("抽獎券可拆分闆闆消費券與陪陪接單券", () => {
  assert.deepEqual(
    splitRaffleTickets({
      totalAmount: 3455,
      totalTickets: 5,
      amountPerTicket: 1000,
    }),
    { customerTickets: 3, staffTickets: 2, totalTickets: 5 },
  );
});

test("沒有抽獎資格時顯示零張", () => {
  assert.deepEqual(
    splitRaffleTickets({
      totalAmount: 0,
      totalTickets: 0,
      amountPerTicket: 1000,
    }),
    { customerTickets: 0, staffTickets: 0, totalTickets: 0 },
  );
});
