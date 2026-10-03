-- Леджер ставок (bids). Каждая строка — снапшот баланса после события:
-- setBalance пишет фактический баланс (note='setbids:N'), recordBidSpent —
-- предыдущий восстановленный баланс минус 1. Баланс в момент времени =
-- delta последней строки + реген с её ts.
CREATE TABLE IF NOT EXISTS bid_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  note TEXT
);
