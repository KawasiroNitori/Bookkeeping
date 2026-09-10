const LEDGER_SPREADSHEET_ID = "1wSA0LK-FaAVv44CU4VzdOEhlYC81OmFrE2BQ1ZbyfF4";

const LEDGER_SHEETS = {
  members: {
    name: "members",
    headers: ["id", "name", "balance"],
  },
  transactions: {
    name: "transactions",
    headers: [
      "id",
      "date",
      "type",
      "amount",
      "memo",
      "memberId",
      "memberIds",
      "amountPerPerson",
      "fromMemberId",
      "toMemberId",
      "payerId",
      "sharedAmount",
    ],
  },
  deliveryParticipants: {
    name: "delivery_participants",
    headers: ["txnId", "memberId", "amount"],
  },
};

function doGet() {
  const ss = ledgerSpreadsheet_();
  ensureLedgerSheets_(ss);

  const participantsByTxnId = readParticipantsByTxnId_(ss);
  const transactions = readTransactions_(ss).map(function (txn) {
    txn.participants = participantsByTxnId[txn.id] || [];
    return txn;
  });

  return json_({
    ok: true,
    backendVersion: "20260910-append-only",
    capabilities: [
      "appendTransaction",
      "appendTransactions",
      "updateTransaction",
      "deleteTransaction",
      "addMember",
      "updateMember",
      "deleteMember",
    ],
    members: readMembers_(ss),
    transactions: transactions,
  });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  let locked = false;

  try {
    lock.waitLock(30000);
    locked = true;

    const payload = parsePayload_(e);
    const action = String(payload.action || "saveAll");
    const ss = ledgerSpreadsheet_();
    ensureLedgerSheets_(ss);

    if (action === "saveAll") {
      replaceAll_(ss, payload.members || [], payload.transactions || []);
      return json_({ ok: true, action: action });
    }

    if (action === "appendTransaction") {
      const appended = appendTransactionIfMissing_(ss, payload.transaction);
      if (appended) applyMemberDeltas_(ss, payload.memberDeltas || []);
      return json_({ ok: true, action: action, appended: appended });
    }

    if (action === "appendTransactions") {
      const transactions = payload.transactions || [];
      let appendedCount = 0;
      transactions.forEach(function (txn) {
        if (appendTransactionIfMissing_(ss, txn)) appendedCount += 1;
      });
      if (appendedCount > 0 && payload.memberDeltas) {
        applyMemberDeltas_(ss, payload.memberDeltas);
      }
      return json_({ ok: true, action: action, appended: appendedCount });
    }

    if (action === "updateTransaction") {
      upsertTransaction_(ss, payload.transaction);
      applyMemberDeltas_(ss, payload.memberDeltas || []);
      return json_({ ok: true, action: action });
    }

    if (action === "deleteTransaction") {
      deleteTransaction_(ss, payload.transactionId);
      applyMemberDeltas_(ss, payload.memberDeltas || []);
      return json_({ ok: true, action: action });
    }

    if (action === "addMember") {
      upsertMember_(ss, payload.member);
      return json_({ ok: true, action: action });
    }

    if (action === "updateMember") {
      upsertMember_(ss, payload.member);
      return json_({ ok: true, action: action });
    }

    if (action === "deleteMember") {
      deleteRowsByValue_(sheet_(ss, LEDGER_SHEETS.members), LEDGER_SHEETS.members, "id", payload.memberId);
      return json_({ ok: true, action: action });
    }

    throw new Error("Unknown action: " + action);
  } catch (error) {
    return json_({
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  } finally {
    if (locked) lock.releaseLock();
  }
}

function ledgerSpreadsheet_() {
  return SpreadsheetApp.openById(LEDGER_SPREADSHEET_ID);
}

function parsePayload_(e) {
  const contents = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
  return JSON.parse(contents || "{}");
}

function json_(value) {
  return ContentService
    .createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function ensureLedgerSheets_(ss) {
  sheet_(ss, LEDGER_SHEETS.members);
  sheet_(ss, LEDGER_SHEETS.transactions);
  sheet_(ss, LEDGER_SHEETS.deliveryParticipants);
}

function sheet_(ss, spec) {
  let target = ss.getSheetByName(spec.name);
  if (!target) target = ss.insertSheet(spec.name);
  ensureHeaders_(target, spec.headers);
  return target;
}

function ensureHeaders_(target, requiredHeaders) {
  if (target.getLastRow() === 0 || target.getLastColumn() === 0) {
    ensureColumnCapacity_(target, requiredHeaders.length);
    target.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    return;
  }

  const width = Math.max(target.getLastColumn(), 1);
  const existing = target.getRange(1, 1, 1, width).getValues()[0].map(stringValue_);
  const hasAnyHeader = existing.some(function (header) {
    return header;
  });

  if (!hasAnyHeader) {
    ensureColumnCapacity_(target, requiredHeaders.length);
    target.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    return;
  }

  const seen = {};
  existing.forEach(function (header) {
    if (header) seen[header] = true;
  });

  const missing = requiredHeaders.filter(function (header) {
    return !seen[header];
  });

  if (!missing.length) return;

  ensureColumnCapacity_(target, existing.length + missing.length);
  target.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
}

function ensureColumnCapacity_(target, requiredColumnCount) {
  const missing = requiredColumnCount - target.getMaxColumns();
  if (missing > 0) target.insertColumnsAfter(target.getMaxColumns(), missing);
}

function headers_(target, spec) {
  ensureHeaders_(target, spec.headers);
  const width = Math.max(target.getLastColumn(), spec.headers.length);
  return target.getRange(1, 1, 1, width).getValues()[0].map(stringValue_);
}

function readObjects_(target, spec) {
  const headerValues = headers_(target, spec);
  const lastRow = target.getLastRow();
  if (lastRow < 2) return [];

  return target
    .getRange(2, 1, lastRow - 1, headerValues.length)
    .getValues()
    .filter(function (row) {
      return row.some(function (value) {
        return stringValue_(value) !== "";
      });
    })
    .map(function (row) {
      const obj = {};
      headerValues.forEach(function (header, index) {
        if (header) obj[header] = row[index];
      });
      return obj;
    });
}

function readMembers_(ss) {
  return readObjects_(sheet_(ss, LEDGER_SHEETS.members), LEDGER_SHEETS.members)
    .filter(function (row) {
      return stringValue_(row.id);
    })
    .map(function (row) {
      return {
        id: stringValue_(row.id),
        name: stringValue_(row.name),
        balance: numberValue_(row.balance),
      };
    });
}

function readTransactions_(ss) {
  return readObjects_(sheet_(ss, LEDGER_SHEETS.transactions), LEDGER_SHEETS.transactions)
    .filter(function (row) {
      return stringValue_(row.id);
    })
    .map(function (row) {
      return {
        id: stringValue_(row.id),
        date: stringValue_(row.date),
        type: stringValue_(row.type || "shared"),
        amount: numberValue_(row.amount),
        memo: stringValue_(row.memo),
        memberId: stringValue_(row.memberId),
        memberIds: splitIds_(row.memberIds),
        amountPerPerson: numberValue_(row.amountPerPerson),
        fromMemberId: stringValue_(row.fromMemberId),
        toMemberId: stringValue_(row.toMemberId),
        payerId: stringValue_(row.payerId),
        sharedAmount: numberValue_(row.sharedAmount),
        participants: [],
      };
    });
}

function readParticipantsByTxnId_(ss) {
  const result = {};
  readObjects_(sheet_(ss, LEDGER_SHEETS.deliveryParticipants), LEDGER_SHEETS.deliveryParticipants)
    .forEach(function (row) {
      const txnId = stringValue_(row.txnId);
      const memberId = stringValue_(row.memberId);
      if (!txnId || !memberId) return;
      if (!result[txnId]) result[txnId] = [];
      result[txnId].push({
        id: memberId,
        amount: numberValue_(row.amount),
      });
    });
  return result;
}

function replaceAll_(ss, members, transactions) {
  const membersSheet = sheet_(ss, LEDGER_SHEETS.members);
  const transactionsSheet = sheet_(ss, LEDGER_SHEETS.transactions);
  const participantsSheet = sheet_(ss, LEDGER_SHEETS.deliveryParticipants);

  resetSheet_(membersSheet, LEDGER_SHEETS.members.headers);
  resetSheet_(transactionsSheet, LEDGER_SHEETS.transactions.headers);
  resetSheet_(participantsSheet, LEDGER_SHEETS.deliveryParticipants.headers);

  members.map(normalizeMember_).forEach(function (member) {
    appendObject_(membersSheet, LEDGER_SHEETS.members, member);
  });

  transactions.map(normalizeTransaction_).forEach(function (txn) {
    appendObject_(transactionsSheet, LEDGER_SHEETS.transactions, transactionRowObject_(txn));
    appendParticipants_(participantsSheet, txn);
  });
}

function resetSheet_(target, headerValues) {
  target.clearContents();
  ensureColumnCapacity_(target, headerValues.length);
  target.getRange(1, 1, 1, headerValues.length).setValues([headerValues]);
}

function appendTransactionIfMissing_(ss, input) {
  const txn = normalizeTransaction_(input);
  if (!txn.id) throw new Error("Transaction id is required.");

  const transactionsSheet = sheet_(ss, LEDGER_SHEETS.transactions);
  if (findRowByValue_(transactionsSheet, LEDGER_SHEETS.transactions, "id", txn.id)) {
    return false;
  }

  appendObject_(transactionsSheet, LEDGER_SHEETS.transactions, transactionRowObject_(txn));
  appendParticipants_(sheet_(ss, LEDGER_SHEETS.deliveryParticipants), txn);
  return true;
}

function upsertTransaction_(ss, input) {
  const txn = normalizeTransaction_(input);
  if (!txn.id) throw new Error("Transaction id is required.");

  const transactionsSheet = sheet_(ss, LEDGER_SHEETS.transactions);
  const rowNumber = findRowByValue_(transactionsSheet, LEDGER_SHEETS.transactions, "id", txn.id);
  const rowObject = transactionRowObject_(txn);

  if (rowNumber) {
    writeObject_(transactionsSheet, LEDGER_SHEETS.transactions, rowNumber, rowObject);
  } else {
    appendObject_(transactionsSheet, LEDGER_SHEETS.transactions, rowObject);
  }

  const participantsSheet = sheet_(ss, LEDGER_SHEETS.deliveryParticipants);
  deleteRowsByValue_(participantsSheet, LEDGER_SHEETS.deliveryParticipants, "txnId", txn.id);
  appendParticipants_(participantsSheet, txn);
}

function deleteTransaction_(ss, transactionId) {
  const id = stringValue_(transactionId);
  if (!id) return;

  deleteRowsByValue_(sheet_(ss, LEDGER_SHEETS.transactions), LEDGER_SHEETS.transactions, "id", id);
  deleteRowsByValue_(sheet_(ss, LEDGER_SHEETS.deliveryParticipants), LEDGER_SHEETS.deliveryParticipants, "txnId", id);
}

function upsertMember_(ss, input) {
  const member = normalizeMember_(input);
  if (!member.id) throw new Error("Member id is required.");

  const membersSheet = sheet_(ss, LEDGER_SHEETS.members);
  const rowNumber = findRowByValue_(membersSheet, LEDGER_SHEETS.members, "id", member.id);

  if (rowNumber) {
    writeObject_(membersSheet, LEDGER_SHEETS.members, rowNumber, member);
  } else {
    appendObject_(membersSheet, LEDGER_SHEETS.members, member);
  }
}

function applyMemberDeltas_(ss, deltas) {
  if (!deltas || !deltas.length) return;

  const membersSheet = sheet_(ss, LEDGER_SHEETS.members);
  const headerValues = headers_(membersSheet, LEDGER_SHEETS.members);
  const balanceIndex = headerValues.indexOf("balance");
  if (balanceIndex < 0) throw new Error("members.balance header is missing.");

  deltas.forEach(function (item) {
    const memberId = stringValue_(item.memberId);
    const delta = numberValue_(item.delta);
    if (!memberId || !delta) return;

    const rowNumber = findRowByValue_(membersSheet, LEDGER_SHEETS.members, "id", memberId);
    if (!rowNumber) return;

    const balanceCell = membersSheet.getRange(rowNumber, balanceIndex + 1);
    balanceCell.setValue(numberValue_(balanceCell.getValue()) + delta);
  });
}

function appendParticipants_(participantsSheet, txn) {
  normalizeParticipants_(txn.participants).forEach(function (participant) {
    appendObject_(participantsSheet, LEDGER_SHEETS.deliveryParticipants, {
      txnId: txn.id,
      memberId: participant.id,
      amount: participant.amount,
    });
  });
}

function appendObject_(target, spec, obj) {
  const headerValues = headers_(target, spec);
  target.appendRow(rowForHeaders_(headerValues, obj));
}

function writeObject_(target, spec, rowNumber, obj) {
  const headerValues = headers_(target, spec);
  target.getRange(rowNumber, 1, 1, headerValues.length).setValues([rowForHeaders_(headerValues, obj)]);
}

function rowForHeaders_(headerValues, obj) {
  return headerValues.map(function (header) {
    if (!header) return "";
    const value = obj[header];
    return value === undefined || value === null ? "" : value;
  });
}

function findRowByValue_(target, spec, headerName, value) {
  const targetValue = stringValue_(value);
  if (!targetValue) return 0;

  const headerValues = headers_(target, spec);
  const columnIndex = headerValues.indexOf(headerName);
  const lastRow = target.getLastRow();
  if (columnIndex < 0 || lastRow < 2) return 0;

  const values = target.getRange(2, columnIndex + 1, lastRow - 1, 1).getDisplayValues();
  for (let index = 0; index < values.length; index += 1) {
    if (String(values[index][0]) === targetValue) return index + 2;
  }
  return 0;
}

function deleteRowsByValue_(target, spec, headerName, value) {
  const targetValue = stringValue_(value);
  if (!targetValue) return 0;

  const headerValues = headers_(target, spec);
  const columnIndex = headerValues.indexOf(headerName);
  const lastRow = target.getLastRow();
  if (columnIndex < 0 || lastRow < 2) return 0;

  const values = target.getRange(2, columnIndex + 1, lastRow - 1, 1).getDisplayValues();
  let deleted = 0;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (String(values[index][0]) === targetValue) {
      target.deleteRow(index + 2);
      deleted += 1;
    }
  }
  return deleted;
}

function normalizeMember_(input) {
  const member = input || {};
  return {
    id: stringValue_(member.id),
    name: stringValue_(member.name),
    balance: numberValue_(member.balance),
  };
}

function normalizeTransaction_(input) {
  const txn = input || {};
  return {
    id: stringValue_(txn.id || Utilities.getUuid()),
    date: stringValue_(txn.date || new Date().toISOString()),
    type: stringValue_(txn.type || "shared"),
    amount: numberValue_(txn.amount),
    memo: stringValue_(txn.memo),
    memberId: stringValue_(txn.memberId),
    memberIds: splitIds_(txn.memberIds),
    amountPerPerson: numberValue_(txn.amountPerPerson),
    fromMemberId: stringValue_(txn.fromMemberId),
    toMemberId: stringValue_(txn.toMemberId),
    payerId: stringValue_(txn.payerId),
    sharedAmount: numberValue_(txn.sharedAmount),
    participants: normalizeParticipants_(txn.participants),
  };
}

function transactionRowObject_(txn) {
  return {
    id: txn.id,
    date: txn.date,
    type: txn.type,
    amount: txn.amount,
    memo: txn.memo,
    memberId: txn.memberId,
    memberIds: txn.memberIds.join(","),
    amountPerPerson: txn.amountPerPerson,
    fromMemberId: txn.fromMemberId,
    toMemberId: txn.toMemberId,
    payerId: txn.payerId,
    sharedAmount: txn.sharedAmount,
  };
}

function normalizeParticipants_(value) {
  let items = [];
  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === "string" && value.trim().charAt(0) === "[") {
    try {
      items = JSON.parse(value);
    } catch (error) {
      items = [];
    }
  }

  return items
    .map(function (item) {
      return {
        id: stringValue_(item.id || item.memberId),
        amount: numberValue_(item.amount),
      };
    })
    .filter(function (item) {
      return item.id;
    });
}

function splitIds_(value) {
  if (Array.isArray(value)) {
    return value.map(stringValue_).filter(Boolean);
  }
  return stringValue_(value)
    .split(",")
    .map(function (item) {
      return item.trim();
    })
    .filter(Boolean);
}

function stringValue_(value) {
  if (value === undefined || value === null) return "";
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime())) {
    return value.toISOString();
  }
  return String(value);
}

function numberValue_(value) {
  if (value === undefined || value === null || value === "") return 0;
  const number = Number(String(value).replace(/,/g, ""));
  return isFinite(number) ? number : 0;
}
