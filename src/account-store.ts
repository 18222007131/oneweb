import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AccountType = "internal" | "external";

export interface AccountSession {
  username: string;
  type: AccountType;
}

interface AccountStoreData {
  accounts: Record<string, AccountType>;
  lastLoggedIn: string | null;
}

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNTS_FILE = path.join(PROJECT_ROOT, "accounts.json");

const SEED_STORE: AccountStoreData = {
  accounts: {
    admin: "internal",
    warehouse01: "internal",
  },
  lastLoggedIn: "admin",
};

function cloneStore(data: AccountStoreData): AccountStoreData {
  return {
    accounts: { ...data.accounts },
    lastLoggedIn: data.lastLoggedIn,
  };
}

function writeStore(data: AccountStoreData): void {
  fs.writeFileSync(ACCOUNTS_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function isAccountType(value: unknown): value is AccountType {
  return value === "internal" || value === "external";
}

function readStore(): AccountStoreData {
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    const seed = cloneStore(SEED_STORE);
    writeStore(seed);
    return seed;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
  } catch (error) {
    throw new Error(
      `accounts.json 无法解析：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("accounts.json 格式错误：根节点必须是对象。");
  }
  const raw = parsed as {
    accounts?: unknown;
    lastLoggedIn?: unknown;
  };
  if (!raw.accounts || typeof raw.accounts !== "object") {
    throw new Error("accounts.json 格式错误：accounts 必须是对象。");
  }

  const accounts: Record<string, AccountType> = {};
  for (const [name, type] of Object.entries(
    raw.accounts as Record<string, unknown>,
  )) {
    if (!name.trim() || !isAccountType(type)) {
      throw new Error(
        `accounts.json 格式错误：账号 ${name || "(空)"} 的身份必须是 internal 或 external。`,
      );
    }
    accounts[name.trim()] = type;
  }

  const lastLoggedIn =
    typeof raw.lastLoggedIn === "string" && raw.lastLoggedIn.trim()
      ? raw.lastLoggedIn.trim()
      : null;

  return { accounts, lastLoggedIn };
}

function sessionFor(store: AccountStoreData, username: string): AccountSession {
  const name = username.trim();
  if (!name) {
    throw new Error("账号不能为空。");
  }
  if (!store.accounts[name]) {
    // 未预先登记的账号默认是库外账号
    store.accounts[name] = "external";
  }
  return { username: name, type: store.accounts[name] };
}

/** 启动时自动登录 accounts.json 中记录的上次账号。 */
export function getAutoLoginAccount(): AccountSession | null {
  const store = readStore();
  if (!store.lastLoggedIn) return null;

  const existed = Boolean(store.accounts[store.lastLoggedIn]);
  const session = sessionFor(store, store.lastLoggedIn);
  if (!existed) {
    writeStore(store);
  }
  return session;
}

/** 登录/切换账号；未知账号按库外账号登记。 */
export function loginAccount(username: string): AccountSession {
  const store = readStore();
  const session = sessionFor(store, username);
  store.lastLoggedIn = session.username;
  writeStore(store);
  return session;
}

/** 退出登录：清空上次登录账号，但保留已登记账号身份。 */
export function logoutAccount(): void {
  const store = readStore();
  store.lastLoggedIn = null;
  writeStore(store);
}

export function accountTypeLabel(type: AccountType): string {
  return type === "internal" ? "库内账号" : "库外账号";
}

/** 库外账号只允许提交预约和查看自己的预约单；库内账号可使用全部业务菜单。 */
export function canAccessBusinessMenu(
  type: AccountType,
  menuChoice: string,
): boolean {
  if (menuChoice === "1" || menuChoice === "3") {
    return true;
  }
  if (["2", "4", "8", "9"].includes(menuChoice)) {
    return type === "internal";
  }
  return false;
}
