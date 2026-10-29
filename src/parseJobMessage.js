const { identifierPattern: facilityPattern } = require("./identifiers");

const parseBoolean = (value) => {
  const normalized = `${value}`.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return null;
};

const parseInteger = (name, value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
};

const parseJobMessage = (caption) => {
  if (!caption || !/^\/run(\s|@|$)/i.test(caption.trim())) {
    return null;
  }

  const withoutCommand = caption.trim().replace(/^\/run(@\w+)?/i, "").trim();
  const tokens = withoutCommand.split(/\s+/).filter(Boolean);
  const values = {};

  for (const token of tokens) {
    const separatorIndex = token.indexOf("=");
    if (separatorIndex === -1) {
      if (!values.facility) {
        values.facility = token;
        continue;
      }
      continue;
    }
    const key = token.slice(0, separatorIndex).trim().toLowerCase();
    const value = token.slice(separatorIndex + 1).trim();
    values[key] = value;
  }

  const facilityId =
    values.username || values.facility || values.id || values.customer;
  if (!facilityPattern.test(facilityId || "")) {
    throw new Error("Missing or invalid username=<username>");
  }

  const params = {};
  if (values.entriesperdate !== undefined) {
    params.entriesPerDate = parseInteger("entriesPerDate", values.entriesperdate, {
      min: 0,
    });
  }
  if (values.concurrency !== undefined) {
    params.concurrency = parseInteger("concurrency", values.concurrency, {
      min: 1,
      max: 20,
    });
  }
  if (values.successentries !== undefined) {
    params.successEntries = parseInteger("successEntries", values.successentries, {
      min: 0,
    });
  }
  if (values.dryrun !== undefined) {
    const dryRun = parseBoolean(values.dryrun);
    if (dryRun === null) {
      throw new Error(`Invalid dryRun: ${values.dryrun}`);
    }
    params.dryRun = dryRun;
  }
  if (values.overwriterandomdata !== undefined) {
    const overwrite = parseBoolean(values.overwriterandomdata);
    if (overwrite === null) {
      throw new Error(`Invalid overwriteRandomData: ${values.overwriterandomdata}`);
    }
    params.overwriteRandomData = overwrite;
  }
  if (values.writepreparedsheet !== undefined) {
    const writePrepared = parseBoolean(values.writepreparedsheet);
    if (writePrepared === null) {
      throw new Error(`Invalid writePreparedSheet: ${values.writepreparedsheet}`);
    }
    params.writePreparedSheet = writePrepared;
  }

  return { facilityId, params };
};

const helpText = ({ isAdmin = false, isAllowedUser = false } = {}) => {
  const lines = ["🤖 <b>NCD Data Entry Bot</b>", ""];

  if (isAllowedUser || isAdmin) {
    lines.push(
      "👤 <b>Your account setup</b> <i>(private chat)</i>",
      "• <code>/onboard &lt;username&gt;</code> — add your account + login",
      "• <code>/login &lt;username&gt;</code> — renew an expired session",
      "• <code>/remove &lt;username&gt;</code> — remove credentials only",
      "• <code>/remove &lt;username&gt; all</code> — purge local jobs/files",
    );
    if (!isAdmin) {
      lines.push(
        "• <code>/facilities</code> — list your accounts",
        "• <code>/jobs [username]</code> — your recent jobs",
        "• <code>/job &lt;job-id&gt;</code> — job details",
        "• <code>/report &lt;job-id&gt;</code> — resend a completed report",
      );
    }
    lines.push(
      "",
      "▶️ <b>Run a job</b> <i>(private chat)</i>",
      "• <code>/run &lt;username&gt;</code> — guided setup",
      "• <b>Custom:</b> <code>/run username=&lt;username&gt; entriesPerDate=200 concurrency=5 successEntries=50 dryRun=0</code>",
      "• Sheet name: <code>&lt;username&gt;.xlsx</code>",
      "• <code>/cancel</code> — cancel onboarding or job setup",
      "",
    );
  }

  if (isAdmin) {
    lines.push(
      "🔐 <b>Admin view</b>",
      "• <code>/facilities</code> — active allowed users and their accounts",
      "• <code>/jobs [username]</code> — active users' jobs",
      "• <code>/job &lt;job-id&gt;</code> — job details",
      "• <code>/report &lt;job-id&gt;</code> — resend a completed report",
    );
    lines.push(
      "• You have full admin and user access.",
      "",
    );
  }

  lines.push("", "🔒 <b>Access</b>", "• Private chats only.");
  if (isAdmin) {
    lines.push("• Add users to <code>ALLOWED_TELEGRAM_IDS</code>.");
  }

  return lines.join("\n");
};

module.exports = { parseJobMessage, helpText, facilityPattern };
