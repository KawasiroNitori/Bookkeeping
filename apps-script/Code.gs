const LEDGER_SPREADSHEET_ID = "1OIVAlCIiRUWUTLctATHCVEXXYcyMM7sHriQL8pCv3dg";
const BACKEND_VERSION = "20260910-flat-ledger-v1";
const SCHEMA_VERSION = "flat-member-columns-v1";
const REVIEW_TXN_PREFIX = "__restaurant_review__:";

const MEMBERS_SHEET = {
  name: "members",
  headers: ["id", "name", "balance", "active", "notes"],
};

const TRANSACTIONS_SHEET = {
  name: "transactions",
  baseHeaders: [
    "id",
    "transactionDate",
    "createdAt",
    "type",
    "typeLabel",
    "memo",
    "amount",
    "memberId",
    "memberIds",
    "fromMemberId",
    "toMemberId",
    "payerId",
    "sharedAmount",
    "amountPerPerson",
    "participantsJson",
    "restaurantReviewJson",
    "deltaTotal",
  ],
};

function doGet() {
  const ss = ledgerSpreadsheet_();
  ensureLedgerSheets_(ss);

  const members = readMembers_(ss);
  ensureMemberTransactionColumns_(ss, members);

  return json_({
    ok: true,
    backendVersion: BACKEND_VERSION,
    schemaVersion: SCHEMA_VERSION,
    capabilities: [
      "appendTransaction",
      "appendTransactions",
      "updateTransaction",
      "deleteTransaction",
      "addMember",
      "updateMember",
      "deleteMember",
    ],
    members: members,
    transactions: readTransactions_(ss, members),
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
      return json_({ ok: true, action: action, schemaVersion: SCHEMA_VERSION });
    }

    if (action === "appendTransaction") {
      const appended = appendTransactionIfMissing_(ss, payload.transaction, payload.memberDeltas || []);
      if (appended) applyMemberDeltas_(ss, payload.memberDeltas || []);
      return json_({ ok: true, action: action, appended: appended });
    }

    if (action === "appendTransactions") {
      let appendedCount = 0;
      (payload.transactions || []).forEach(function (txn) {
        if (appendTransactionIfMissing_(ss, txn, txn.memberDeltas || [])) appendedCount += 1;
      });
      if (appendedCount > 0 && payload.memberDeltas) applyMemberDeltas_(ss, payload.memberDeltas);
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
      ensureMemberTransactionColumns_(ss, readMembers_(ss));
      return json_({ ok: true, action: action });
    }

    if (action === "updateMember") {
      upsertMember_(ss, payload.member);
      ensureMemberTransactionColumns_(ss, readMembers_(ss));
      return json_({ ok: true, action: action });
    }

    if (action === "deleteMember") {
      deleteRowsByValue_(sheet_(ss, MEMBERS_SHEET), MEMBERS_SHEET.headers, "id", payload.memberId);
      return json_({ ok: true, action: action, preservedTransactionColumn: true });
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
  sheet_(ss, MEMBERS_SHEET);
  const transactions = ss.getSheetByName(TRANSACTIONS_SHEET.name) || ss.insertSheet(TRANSACTIONS_SHEET.name);
  ensureHeaders_(transactions, TRANSACTIONS_SHEET.baseHeaders);
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
  const existing = target.getRange(1, 1, 1, width).getDisplayValues()[0].map(clean_);
  const hasAnyHeader = existing.some(Boolean);

  if (!hasAnyHeader) {
    ensureColumnCapacity_(target, requiredHeaders.length);
    target.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    return;
  }

  const missing = requiredHeaders.filter(function (header) {
    return existing.indexOf(header) < 0;
  });
  if (!missing.length) return;

  ensureColumnCapacity_(target, existing.length + missing.length);
  target.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
}

function ensureColumnCapacity_(target, requiredColumnCount) {
  const missing = requiredColumnCount - target.getMaxColumns();
  if (missing > 0) target.insertColumnsAfter(target.getMaxColumns(), missing);
}

function transactionSheet_(ss) {
  const target = ss.getSheetByName(TRANSACTIONS_SHEET.name) || ss.insertSheet(TRANSACTIONS_SHEET.name);
  ensureHeaders_(target, TRANSACTIONS_SHEET.baseHeaders);
  return target;
}

function headers_(target, fallbackHeaders) {
  ensureHeaders_(target, fallbackHeaders);
  const width = Math.max(target.getLastColumn(), fallbackHeaders.length);
  return target.getRange(1, 1, 1, width).getDisplayValues()[0].map(clean_);
}

function readObjects_(target, fallbackHeaders) {
  const headerValues = headers_(target, fallbackHeaders);
  const lastRow = target.getLastRow();
  if (lastRow < 2) return [];

  return target
    .getRange(2, 1, lastRow - 1, headerValues.length)
    .getValues()
    .filter(function (row) {
      return row.some(function (value) {
        return clean_(value) !== "";
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
  return readObjects_(sheet_(ss, MEMBERS_SHEET), MEMBERS_SHEET.headers)
    .filter(function (row) {
      return clean_(row.id);
    })
    .map(function (row) {
      return {
        id: clean_(row.id),
        name: clean_(row.name),
        balance: number_(row.balance),
        active: row.active === "" ? true : String(row.active).toLowerCase() !== "false",
      };
    });
}

function readTransactions_(ss, members) {
  const target = transactionSheet_(ss);
  const headerValues = headers_(target, TRANSACTIONS_SHEET.baseHeaders);
  const memberColumnMap = memberColumnsFromHeaders_(headerValues);

  return readObjects_(target, TRANSACTIONS_SHEET.baseHeaders)
    .filter(function (row) {
      return clean_(row.id);
    })
    .map(function (row) {
      const memberDeltas = [];
      Object.keys(memberColumnMap).forEach(function (header) {
        const memberId = memberColumnMap[header];
        const delta = number_(row[header]);
        if (delta) memberDeltas.push({ memberId: memberId, delta: delta });
      });

      const txn = {
        id: clean_(row.id),
        transactionDate: dateOnly_(row.transactionDate),
        createdAt: isoDateTime_(row.createdAt),
        date: isoDateTime_(row.createdAt) || dateOnly_(row.transactionDate),
        type: clean_(row.type || "shared"),
        amount: number_(row.amount),
        memo: clean_(row.memo),
        memberId: clean_(row.memberId),
        memberIds: splitIds_(row.memberIds),
        amountPerPerson: number_(row.amountPerPerson),
        fromMemberId: clean_(row.fromMemberId),
        toMemberId: clean_(row.toMemberId),
        payerId: clean_(row.payerId),
        sharedAmount: number_(row.sharedAmount),
        participants: parseParticipants_(row.participantsJson),
        memberDeltas: memberDeltas,
      };

      if (!txn.memberDeltas.length) txn.memberDeltas = computeMemberDeltas_(txn);
      return txn;
    });
}

function replaceAll_(ss, membersInput, transactionsInput) {
  const membersSheet = sheet_(ss, MEMBERS_SHEET);
  const transactionsSheet = transactionSheet_(ss);
  const members = membersInput.map(normalizeMember_);

  resetSheet_(membersSheet, MEMBERS_SHEET.headers);
  members.forEach(function (member) {
    appendObject_(membersSheet, MEMBERS_SHEET.headers, member);
  });

  const transactionHeaders = TRANSACTIONS_SHEET.baseHeaders.concat(members.map(memberHeader_));
  resetSheet_(transactionsSheet, transactionHeaders);
  transactionsInput.map(function (txn) {
    return normalizeTransaction_(txn, members);
  }).forEach(function (txn) {
    appendObject_(transactionsSheet, transactionHeaders, transactionRowObject_(txn, members));
  });
}

function resetSheet_(target, headerValues) {
  target.clearContents();
  ensureColumnCapacity_(target, headerValues.length);
  target.getRange(1, 1, 1, headerValues.length).setValues([headerValues]);
}

function appendTransactionIfMissing_(ss, input, balanceDeltas) {
  const members = readMembers_(ss);
  ensureMemberTransactionColumns_(ss, members);

  const txn = normalizeTransaction_(input, members, balanceDeltas);
  if (!txn.id) throw new Error("Transaction id is required.");

  const target = transactionSheet_(ss);
  if (findRowByValue_(target, TRANSACTIONS_SHEET.baseHeaders, "id", txn.id)) return false;

  appendObject_(target, headers_(target, TRANSACTIONS_SHEET.baseHeaders), transactionRowObject_(txn, members));
  return true;
}

function upsertTransaction_(ss, input) {
  const members = readMembers_(ss);
  ensureMemberTransactionColumns_(ss, members);

  const txn = normalizeTransaction_(input, members);
  if (!txn.id) throw new Error("Transaction id is required.");

  const target = transactionSheet_(ss);
  const rowNumber = findRowByValue_(target, TRANSACTIONS_SHEET.baseHeaders, "id", txn.id);
  const headerValues = headers_(target, TRANSACTIONS_SHEET.baseHeaders);
  const rowObject = transactionRowObject_(txn, members);

  if (rowNumber) {
    writeObject_(target, headerValues, rowNumber, rowObject);
  } else {
    appendObject_(target, headerValues, rowObject);
  }
}

function deleteTransaction_(ss, transactionId) {
  const id = clean_(transactionId);
  if (!id) return;
  deleteRowsByValue_(transactionSheet_(ss), TRANSACTIONS_SHEET.baseHeaders, "id", id);
}

function upsertMember_(ss, input) {
  const member = normalizeMember_(input);
  if (!member.id) throw new Error("Member id is required.");

  const target = sheet_(ss, MEMBERS_SHEET);
  const rowNumber = findRowByValue_(target, MEMBERS_SHEET.headers, "id", member.id);
  const headerValues = headers_(target, MEMBERS_SHEET.headers);

  if (rowNumber) {
    writeObject_(target, headerValues, rowNumber, member);
  } else {
    appendObject_(target, headerValues, member);
  }
}

function ensureMemberTransactionColumns_(ss, members) {
  const target = transactionSheet_(ss);
  let headerValues = headers_(target, TRANSACTIONS_SHEET.baseHeaders);
  const existingByMemberId = {};

  headerValues.forEach(function (header, index) {
    const memberId = memberIdFromHeader_(header);
    if (memberId) existingByMemberId[memberId] = { header: header, index: index };
  });

  const missingHeaders = [];
  members.forEach(function (member) {
    const expected = memberHeader_(member);
    const existing = existingByMemberId[member.id];
    if (existing) {
      if (existing.header !== expected) {
        target.getRange(1, existing.index + 1).setValue(expected);
      }
    } else {
      missingHeaders.push(expected);
    }
  });

  if (missingHeaders.length) {
    headerValues = headers_(target, TRANSACTIONS_SHEET.baseHeaders);
    ensureColumnCapacity_(target, headerValues.length + missingHeaders.length);
    target.getRange(1, headerValues.length + 1, 1, missingHeaders.length).setValues([missingHeaders]);
  }
}

function memberHeader_(member) {
  return "member:" + clean_(member.id) + ":" + clean_(member.name);
}

function memberIdFromHeader_(header) {
  const match = clean_(header).match(/^member:([^:]+):/);
  return match ? match[1] : "";
}

function memberColumnsFromHeaders_(headerValues) {
  const result = {};
  headerValues.forEach(function (header) {
    const memberId = memberIdFromHeader_(header);
    if (memberId) result[header] = memberId;
  });
  return result;
}

function applyMemberDeltas_(ss, deltas) {
  if (!deltas || !deltas.length) return;

  const target = sheet_(ss, MEMBERS_SHEET);
  const headerValues = headers_(target, MEMBERS_SHEET.headers);
  const balanceIndex = headerValues.indexOf("balance");
  if (balanceIndex < 0) throw new Error("members.balance header is missing.");

  deltas.forEach(function (item) {
    const memberId = clean_(item.memberId);
    const delta = number_(item.delta);
    if (!memberId || !delta) return;

    const rowNumber = findRowByValue_(target, MEMBERS_SHEET.headers, "id", memberId);
    if (!rowNumber) return;

    const cell = target.getRange(rowNumber, balanceIndex + 1);
    cell.setValue(number_(cell.getValue()) + delta);
  });
}

function appendObject_(target, headerValues, obj) {
  target.appendRow(rowForHeaders_(headerValues, obj));
}

function writeObject_(target, headerValues, rowNumber, obj) {
  target.getRange(rowNumber, 1, 1, headerValues.length).setValues([rowForHeaders_(headerValues, obj)]);
}

function rowForHeaders_(headerValues, obj) {
  return headerValues.map(function (header) {
    if (!header) return "";
    const value = obj[header];
    return value === undefined || value === null ? "" : value;
  });
}

function findRowByValue_(target, fallbackHeaders, headerName, value) {
  const targetValue = clean_(value);
  if (!targetValue) return 0;

  const headerValues = headers_(target, fallbackHeaders);
  const columnIndex = headerValues.indexOf(headerName);
  const lastRow = target.getLastRow();
  if (columnIndex < 0 || lastRow < 2) return 0;

  const values = target.getRange(2, columnIndex + 1, lastRow - 1, 1).getDisplayValues();
  for (let index = 0; index < values.length; index += 1) {
    if (String(values[index][0]) === targetValue) return index + 2;
  }
  return 0;
}

function deleteRowsByValue_(target, fallbackHeaders, headerName, value) {
  const targetValue = clean_(value);
  if (!targetValue) return 0;

  const headerValues = headers_(target, fallbackHeaders);
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
    id: clean_(member.id),
    name: clean_(member.name),
    balance: number_(member.balance),
    active: member.active === undefined ? true : Boolean(member.active),
    notes: clean_(member.notes),
  };
}

function normalizeTransaction_(input, members, fallbackDeltas) {
  const txn = input || {};
  const normalized = {
    id: clean_(txn.id || Utilities.getUuid()),
    transactionDate: dateOnly_(txn.transactionDate || txn.date || new Date()),
    createdAt: isoDateTime_(txn.createdAt || txn.date || new Date()),
    type: clean_(txn.type || "shared"),
    memo: clean_(txn.memo),
    amount: number_(txn.amount),
    memberId: clean_(txn.memberId),
    memberIds: splitIds_(txn.memberIds),
    fromMemberId: clean_(txn.fromMemberId),
    toMemberId: clean_(txn.toMemberId),
    payerId: clean_(txn.payerId),
    sharedAmount: number_(txn.sharedAmount),
    amountPerPerson: number_(txn.amountPerPerson),
    participants: parseParticipants_(txn.participants),
    memberDeltas: normalizeDeltas_(txn.memberDeltas && txn.memberDeltas.length ? txn.memberDeltas : fallbackDeltas),
  };

  if (!normalized.memberDeltas.length) {
    normalized.memberDeltas = computeMemberDeltas_(normalized, members);
  }
  return normalized;
}

function transactionRowObject_(txn, members) {
  const memberDeltasById = {};
  normalizeDeltas_(txn.memberDeltas).forEach(function (item) {
    memberDeltasById[item.memberId] = (memberDeltasById[item.memberId] || 0) + item.delta;
  });
  const deltaTotal = Object.keys(memberDeltasById).reduce(function (sum, memberId) {
    return sum + memberDeltasById[memberId];
  }, 0);
  const participantsJson = txn.participants && txn.participants.length ? JSON.stringify(txn.participants) : "";
  const restaurantReviewJson = restaurantReviewJson_(txn);

  const row = {
    id: txn.id,
    transactionDate: txn.transactionDate,
    createdAt: txn.createdAt,
    type: txn.type,
    typeLabel: typeLabel_(txn.type),
    memo: txn.memo,
    amount: txn.amount,
    memberId: txn.memberId,
    memberIds: txn.memberIds.join(","),
    fromMemberId: txn.fromMemberId,
    toMemberId: txn.toMemberId,
    payerId: txn.payerId,
    sharedAmount: txn.sharedAmount,
    amountPerPerson: txn.amountPerPerson,
    participantsJson: participantsJson,
    restaurantReviewJson: restaurantReviewJson,
    deltaTotal: deltaTotal,
  };

  members.forEach(function (member) {
    row[memberHeader_(member)] = memberDeltasById[member.id] || 0;
  });
  return row;
}

function computeMemberDeltas_(txn) {
  switch (txn.type) {
    case "deposit":
      return [{ memberId: txn.memberId, delta: number_(txn.amount) }].filter(function (item) { return item.memberId; });
    case "withdraw":
      return [{ memberId: txn.memberId, delta: -number_(txn.amount) }].filter(function (item) { return item.memberId; });
    case "transfer":
      return [
        { memberId: txn.fromMemberId, delta: -number_(txn.amount) },
        { memberId: txn.toMemberId, delta: number_(txn.amount) },
      ].filter(function (item) { return item.memberId; });
    case "shared": {
      const ids = txn.memberIds || [];
      const per = ids.length ? number_(txn.amount) / ids.length : 0;
      return ids.map(function (memberId) {
        return { memberId: memberId, delta: -per };
      });
    }
    case "delivery": {
      const participants = txn.participants || [];
      const sharedPer = participants.length ? number_(txn.sharedAmount) / participants.length : 0;
      const total = number_(txn.amount);
      const payerId = txn.payerId && txn.payerId !== "lab" ? txn.payerId : "";
      return participants.map(function (part) {
        const cost = number_(part.amount) + sharedPer;
        return { memberId: part.id, delta: -cost + (part.id === payerId ? total : 0) };
      });
    }
    default:
      return [];
  }
}

function normalizeDeltas_(deltas) {
  const totals = {};
  (deltas || []).forEach(function (item) {
    const memberId = clean_(item.memberId);
    if (!memberId) return;
    totals[memberId] = (totals[memberId] || 0) + number_(item.delta);
  });
  return Object.keys(totals).map(function (memberId) {
    return { memberId: memberId, delta: totals[memberId] };
  }).filter(function (item) {
    return item.delta;
  });
}

function restaurantReviewJson_(txn) {
  const memo = clean_(txn.memo);
  if (!memo.startsWith(REVIEW_TXN_PREFIX)) return "";
  return memo.slice(REVIEW_TXN_PREFIX.length);
}

function parseParticipants_(value) {
  let raw = value;
  if (Array.isArray(raw)) {
    return raw.map(function (part) {
      return { id: clean_(part.id || part.memberId), amount: number_(part.amount) };
    }).filter(function (part) {
      return part.id;
    });
  }
  raw = clean_(raw);
  if (!raw || raw.charAt(0) !== "[") return [];
  try {
    return parseParticipants_(JSON.parse(raw));
  } catch (error) {
    return [];
  }
}

function splitIds_(value) {
  if (Array.isArray(value)) return value.map(clean_).filter(Boolean);
  return clean_(value).split(",").map(function (item) {
    return item.trim();
  }).filter(Boolean);
}

function dateOnly_(value) {
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  const text = clean_(value);
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function isoDateTime_(value) {
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime())) {
    return value.toISOString();
  }
  const text = clean_(value);
  if (!text) return new Date().toISOString();
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return text;
  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

function clean_(value) {
  if (value === undefined || value === null) return "";
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value.getTime())) {
    return value.toISOString();
  }
  return String(value);
}

function number_(value) {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(String(value).replace(/,/g, ""));
  return isFinite(n) ? n : 0;
}

function typeLabel_(type) {
  const labels = {
    deposit: "입금",
    withdraw: "출금",
    transfer: "송금",
    shared: "공동지출",
    delivery: "배달정산",
    restaurantReview: "식당 리뷰",
  };
  return labels[type] || type || "";
}
