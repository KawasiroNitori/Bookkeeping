import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const root = process.cwd();
const inputPath = path.join(root, "backups", "pre-redesign-20260910", "legacy-apps-script-response.json");
const outputDir = path.join(root, "outputs", "ledger-v2");
const outputPath = path.join(outputDir, "TBIO-account-database-v2.xlsx");
const summaryPath = path.join(outputDir, "migration-summary.json");
const previewPath = path.join(outputDir, "transactions-preview.png");
const flatResponsePath = path.join(outputDir, "flat-ledger-response.json");

const REVIEW_TXN_PREFIX = "__restaurant_review__:";

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function ids(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function participants(value) {
  if (Array.isArray(value)) {
    return value.map((part) => ({ id: String(part.id || part.memberId || ""), amount: number(part.amount) })).filter((part) => part.id);
  }
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      return participants(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

function transactionDate(txn) {
  const source = String(txn.transactionDate || txn.date || txn.createdAt || "");
  const match = source.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function createdAt(txn) {
  return String(txn.createdAt || txn.date || "");
}

function computeChanges(txn) {
  switch (txn.type) {
    case "deposit":
      return [{ memberId: String(txn.memberId || ""), delta: number(txn.amount) }];
    case "withdraw":
      return [{ memberId: String(txn.memberId || ""), delta: -number(txn.amount) }];
    case "transfer":
      return [
        { memberId: String(txn.fromMemberId || ""), delta: -number(txn.amount) },
        { memberId: String(txn.toMemberId || ""), delta: number(txn.amount) },
      ];
    case "shared": {
      const memberIds = ids(txn.memberIds);
      const per = memberIds.length ? number(txn.amount) / memberIds.length : 0;
      return memberIds.map((memberId) => ({ memberId, delta: -per }));
    }
    case "delivery": {
      const parts = participants(txn.participants);
      const sharedPer = parts.length ? number(txn.sharedAmount) / parts.length : 0;
      const total = number(txn.amount);
      const payerId = txn.payerId && txn.payerId !== "lab" ? String(txn.payerId) : "";
      return parts.map((part) => {
        const cost = number(part.amount) + sharedPer;
        return { memberId: part.id, delta: -cost + (part.id === payerId ? total : 0) };
      });
    }
    default:
      return [];
  }
}

function memberDeltas(txn, memberIds) {
  const totals = Object.fromEntries(memberIds.map((memberId) => [memberId, 0]));
  computeChanges(txn).forEach((change) => {
    if (!change.memberId) return;
    totals[change.memberId] = (totals[change.memberId] || 0) + number(change.delta);
  });
  return totals;
}

function typeLabel(type) {
  return {
    deposit: "입금",
    withdraw: "출금",
    shared: "공동지출",
    transfer: "송금",
    delivery: "배달정산",
    restaurantReview: "식당 리뷰",
  }[type] || type || "";
}

function parseReview(txn) {
  const memo = String(txn.memo || "");
  if (!memo.startsWith(REVIEW_TXN_PREFIX)) return null;
  try {
    return JSON.parse(memo.slice(REVIEW_TXN_PREFIX.length));
  } catch {
    return null;
  }
}

function safeSheetName(name) {
  return String(name).slice(0, 31).replace(/[\[\]:*?/\\]/g, " ");
}

function setMatrix(sheet, startCell, values) {
  sheet.getRange(startCell).write(values);
}

function headerFormat(range) {
  range.format = {
    fill: "#2563EB",
    font: { name: "Arial", bold: true, color: "#FFFFFF" },
  };
  range.format.verticalAlignment = "center";
  range.format.wrapText = true;
}

const source = JSON.parse(await fs.readFile(inputPath, "utf8"));
const members = (source.members || []).map((member) => ({
  id: String(member.id),
  name: String(member.name || ""),
  balance: number(member.balance),
}));
const memberIds = members.map((member) => member.id);
const transactions = (source.transactions || []).map((txn) => ({
  ...txn,
  id: String(txn.id || ""),
  type: String(txn.type || ""),
  transactionDate: transactionDate(txn),
  createdAt: createdAt(txn),
  amount: number(txn.amount),
  memo: String(txn.memo || ""),
  memberId: String(txn.memberId || ""),
  memberIds: ids(txn.memberIds),
  amountPerPerson: number(txn.amountPerPerson),
  fromMemberId: String(txn.fromMemberId || ""),
  toMemberId: String(txn.toMemberId || ""),
  payerId: String(txn.payerId || ""),
  sharedAmount: number(txn.sharedAmount),
  participants: participants(txn.participants),
}));

const workbook = Workbook.create();
const txnSheet = workbook.worksheets.add("transactions");
const membersSheet = workbook.worksheets.add("members");
const checksSheet = workbook.worksheets.add("migration_check");
const reviewsSheet = workbook.worksheets.add("restaurant_reviews");

const memberHeaders = members.map((member) => `member:${member.id}:${member.name}`);
const baseHeaders = [
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
];
const txnHeaders = [...baseHeaders, ...memberHeaders];
const txnRows = transactions
  .slice()
  .sort((a, b) => `${a.transactionDate || ""} ${a.createdAt || ""}`.localeCompare(`${b.transactionDate || ""} ${b.createdAt || ""}`))
  .map((txn) => {
    const deltas = memberDeltas(txn, memberIds);
    const review = parseReview(txn);
    const deltaTotal = Object.values(deltas).reduce((sum, value) => sum + value, 0);
    return [
      txn.id,
      txn.transactionDate,
      txn.createdAt,
      txn.type,
      typeLabel(txn.type),
      txn.memo,
      txn.amount,
      txn.memberId,
      txn.memberIds.join(","),
      txn.fromMemberId,
      txn.toMemberId,
      txn.payerId,
      txn.sharedAmount,
      txn.amountPerPerson,
      txn.participants.length ? JSON.stringify(txn.participants) : "",
      review ? JSON.stringify(review) : "",
      deltaTotal,
      ...memberIds.map((memberId) => deltas[memberId] || 0),
    ];
  });

const flatTransactions = transactions.map((txn) => ({
  ...txn,
  date: txn.createdAt || txn.date,
  memberDeltas: Object.entries(memberDeltas(txn, memberIds))
    .map(([memberId, delta]) => ({ memberId, delta }))
    .filter((item) => item.delta),
}));

setMatrix(txnSheet, "A1", [txnHeaders, ...txnRows]);
headerFormat(txnSheet.getRangeByIndexes(0, 0, 1, txnHeaders.length));
txnSheet.getUsedRange().format.font = { name: "Arial", size: 10 };
txnSheet.getRangeByIndexes(1, 1, Math.max(txnRows.length, 1), 1).setNumberFormat("yyyy-mm-dd");
txnSheet.getRangeByIndexes(1, 2, Math.max(txnRows.length, 1), 1).setNumberFormat("yyyy-mm-dd hh:mm");
txnSheet.getRangeByIndexes(1, 6, Math.max(txnRows.length, 1), 1).setNumberFormat("#,##0");
txnSheet.getRangeByIndexes(1, 12, Math.max(txnRows.length, 1), 2).setNumberFormat("#,##0.00");
txnSheet.getRangeByIndexes(1, 16, Math.max(txnRows.length, 1), memberHeaders.length + 1).setNumberFormat("#,##0.00");
txnSheet.freezePanes.freezeRows(1);
txnSheet.showGridLines = false;
txnSheet.getUsedRange().format.autofitColumns();

const memberRows = members.map((member) => [member.id, member.name, member.balance, true, ""]);
setMatrix(membersSheet, "A1", [["id", "name", "balance", "active", "notes"], ...memberRows]);
headerFormat(membersSheet.getRange("A1:E1"));
membersSheet.getUsedRange().format.font = { name: "Arial", size: 10 };
membersSheet.getRangeByIndexes(1, 2, Math.max(memberRows.length, 1), 1).setNumberFormat("#,##0.00");
membersSheet.freezePanes.freezeRows(1);
membersSheet.showGridLines = false;
membersSheet.getUsedRange().format.autofitColumns();

const typeCounts = transactions.reduce((acc, txn) => {
  acc[txn.type] = (acc[txn.type] || 0) + 1;
  return acc;
}, {});
const memberTotals = Object.fromEntries(memberIds.map((memberId) => [memberId, 0]));
transactions.forEach((txn) => {
  const deltas = memberDeltas(txn, memberIds);
  memberIds.forEach((memberId) => {
    memberTotals[memberId] += deltas[memberId] || 0;
  });
});
const checkRows = [
  ["Metric", "Value", "Notes"],
  ["Source members", members.length, "Original Apps Script JSON"],
  ["Source transactions", transactions.length, "Original Apps Script JSON"],
  ["Migrated transaction rows", txnRows.length, "Should match source transactions"],
  ["Member delta columns", memberHeaders.length, "One column per current member"],
  ["Legacy delivery_participants tab", "removed", "Delivery details now live in transactions.participantsJson"],
  ["Drive backup copy", "1gVmq8WliFiXXdjFHjuym_NmhOS_gjeuRoG5hKv9z-q4", "Created before redesign"],
  ["Schema", "flat-member-columns-v1", "Member delta columns use member:<id>:<name> headers"],
  [],
  ["Type", "Count", ""],
  ...Object.entries(typeCounts).map(([type, count]) => [type, count, typeLabel(type)]),
  [],
  ["Member", "Current balance", "Sum of migrated deltas"],
  ...members.map((member) => [member.name, member.balance, memberTotals[member.id] || 0]),
];
setMatrix(checksSheet, "A1", checkRows);
headerFormat(checksSheet.getRange("A1:C1"));
headerFormat(checksSheet.getRange("A10:C10"));
checksSheet.getUsedRange().format.font = { name: "Arial", size: 10 };
checksSheet.getUsedRange().format.autofitColumns();
checksSheet.showGridLines = false;

const reviewRows = transactions
  .map((txn) => ({ txn, parsed: parseReview(txn) }))
  .filter((item) => item.parsed)
  .map(({ txn, parsed }) => [
    txn.id,
    txn.transactionDate,
    parsed.restaurant?.name || "",
    parsed.restaurant?.address || "",
    parsed.review?.memberId || "",
    parsed.review?.rating || "",
    parsed.review?.comment || "",
  ]);
setMatrix(reviewsSheet, "A1", [["transactionId", "transactionDate", "restaurant", "address", "memberId", "rating", "comment"], ...reviewRows]);
headerFormat(reviewsSheet.getRange("A1:G1"));
reviewsSheet.getUsedRange().format.font = { name: "Arial", size: 10 };
reviewsSheet.getUsedRange().format.autofitColumns();
reviewsSheet.freezePanes.freezeRows(1);
reviewsSheet.showGridLines = false;

workbook.recalculate();
await fs.mkdir(outputDir, { recursive: true });
const preview = await workbook.render({
  sheetName: "transactions",
  range: "A1:Z15",
  scale: 1,
  format: "png",
});
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

await fs.writeFile(summaryPath, JSON.stringify({
  schema: "flat-member-columns-v1",
  sourceMembers: members.length,
  sourceTransactions: transactions.length,
  migratedTransactions: txnRows.length,
  typeCounts,
  memberColumnHeaders: memberHeaders,
  outputPath,
}, null, 2));

await fs.writeFile(flatResponsePath, JSON.stringify({
  ok: true,
  backendVersion: "local-flat-ledger-mock",
  schemaVersion: "flat-member-columns-v1",
  capabilities: [
    "appendTransaction",
    "appendTransactions",
    "updateTransaction",
    "deleteTransaction",
    "addMember",
    "updateMember",
    "deleteMember",
  ],
  members,
  transactions: flatTransactions,
}, null, 2));

console.log(JSON.stringify({
  outputPath,
  summaryPath,
  previewPath,
  flatResponsePath,
  members: members.length,
  transactions: transactions.length,
  typeCounts,
}, null, 2));
