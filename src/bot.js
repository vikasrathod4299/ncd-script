const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const { Bot, InlineKeyboard, InputFile } = require("grammy");
const config = require("./config");
const logger = require("./logger");
const { createStorage } = require("./storage");
const { createSecretBox } = require("./crypto");
const { createTokenManager } = require("./tokenManager");
const { createWorker } = require("./worker");
const { parseJobMessage, helpText } = require("./parseJobMessage");
const { identifierPattern, isValidIdentifier } = require("./identifiers");
const { resolveSheetFileName } = require("./jobFile");
const { removeFacility } = require("./removeFacility");
const { readExcelFile } = require("../util.js");

const createBotApp = async () => {
  if (!config.telegramToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }
  if (config.adminIds.length === 0) {
    logger.warn("ADMIN_TELEGRAM_IDS is empty; admin commands will be rejected");
  }

  const storage = createStorage({ dbPath: config.dbPath });
  const primaryAdmin = config.adminIds[0];
  if (primaryAdmin) {
    const claimed = storage.claimUnownedData(primaryAdmin);
    if (claimed.facilities > 0 || claimed.jobs > 0) {
      logger.info(
        `Assigned unowned data to admin ${primaryAdmin}: ` +
          `${claimed.facilities} account(s), ${claimed.jobs} job(s)`,
      );
    }
  }

  const secretBox = createSecretBox({
    keyFile: config.keyFile,
    appSecretKey: config.appSecretKey,
  });

  const bot = new Bot(config.telegramToken);
  const pendingText = new Map();
  const onboarding = new Map();
  const runWizard = new Map();
  const progressMessages = new Map();
  const authNoticeAt = new Map();

  const isAdmin = (userId) => config.adminIds.includes(`${userId}`);

  const isUserAllowed = (userId) =>
    isAdmin(userId) || config.allowedUserIds.includes(`${userId}`);

  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private") {
      return;
    }
    if (!isUserAllowed(ctx.from?.id)) {
      await ctx
        .reply(
          `🔒 This bot is private.\n` +
            `Your Telegram ID: ${ctx.from?.id}\n` +
            `Ask the owner to add it to ALLOWED_TELEGRAM_IDS.`,
        )
        .catch(() => {});
      return;
    }
    return next();
  });

  const actorId = (ctx) => `${ctx.from?.id}`;

  const activeOwnerIds = () => [
    ...new Set([...config.adminIds, ...config.allowedUserIds]),
  ];

  const isActiveAllowedUser = (userId) =>
    Boolean(userId && activeOwnerIds().includes(`${userId}`));

  const canAccessFacility = (ctx, facility) => {
    if (!facility) {
      return false;
    }
    if (isAdmin(ctx.from?.id)) {
      return isActiveAllowedUser(facility.ownerId);
    }
    return facility.ownerId === actorId(ctx);
  };

  const canOnboardFacility = (ctx, facility) =>
    !facility ||
    isAdmin(ctx.from?.id) ||
    facility.ownerId === actorId(ctx);

  const canAccessJob = (ctx, job) => {
    if (!job) {
      return false;
    }
    if (job.ownerId) {
      return isAdmin(ctx.from?.id)
        ? isActiveAllowedUser(job.ownerId)
        : job.ownerId === actorId(ctx);
    }
    return canAccessFacility(ctx, storage.getFacility(job.facilityId));
  };

  const formatJobTime = (timestamp) => {
    if (!timestamp) {
      return "not started";
    }
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(timestamp));
  };

  const formatCount = (value) =>
    new Intl.NumberFormat("en-IN").format(value || 0);

  const escapeHtml = (value) =>
    `${value ?? ""}`
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const jobStatusMeta = {
    completed: { icon: "✅", label: "Completed" },
    running: { icon: "🔄", label: "Running" },
    queued: { icon: "⏳", label: "Queued" },
    failed: { icon: "❌", label: "Failed" },
    auth_required: { icon: "🔐", label: "Login required" },
    cancelled: { icon: "⛔", label: "Cancelled" },
  };

  const getJobStatusMeta = (status) =>
    jobStatusMeta[status] || { icon: "•", label: status };

  const adminChatId = () => config.adminIds[0];

  const safeDelete = async (ctx) => {
    try {
      await ctx.deleteMessage();
    } catch {
      // Ignore missing delete permission.
    }
  };

  const waitForText = (userId, timeoutMs) =>
    new Promise((resolve, reject) => {
      const key = `${userId}`;
      const existing = pendingText.get(key);
      if (existing) {
        existing.reject(new Error("Superseded by a new request"));
      }
      const timer = setTimeout(() => {
        if (pendingText.get(key) === entry) {
          pendingText.delete(key);
        }
        reject(new Error("Timed out waiting for reply"));
      }, timeoutMs);
      const entry = {
        resolve: (value) => {
          clearTimeout(timer);
          if (pendingText.get(key) === entry) {
            pendingText.delete(key);
          }
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          if (pendingText.get(key) === entry) {
            pendingText.delete(key);
          }
          reject(error);
        },
      };
      pendingText.set(key, entry);
    });

  const notifyUsers = async (userIds, text) => {
    for (const userId of new Set(userIds.filter(Boolean))) {
      try {
        await bot.api.sendMessage(userId, text);
      } catch (error) {
        logger.warn(`Could not notify user ${userId}: ${error.message}`);
      }
    }
  };

  const notifyAuthRequired = (facilityId, error) => {
    const last = authNoticeAt.get(facilityId) || 0;
    if (Date.now() - last < 60 * 60 * 1000) {
      return;
    }
    authNoticeAt.set(facilityId, Date.now());
    const facility = storage.getFacility(facilityId);
    notifyUsers(
      [...config.adminIds, facility?.ownerId],
      `Authentication required for account "${facilityId}".\n` +
        `Run /login ${facilityId} to renew the session.\n` +
        `Reason: ${error?.message || "token refresh failed"}`,
    );
  };

  const tokenManager = createTokenManager({
    storage,
    secretBox,
    config,
    logger,
    onAuthRequired: ({ facilityId, error }) => notifyAuthRequired(facilityId, error),
  });

  const notifier = {
    onJobStarted: async (job) => {
      const chatId = job.chatId || adminChatId();
      if (!chatId) {
        return;
      }
      const message = await bot.api.sendMessage(
        chatId,
        `Started job ${job.id}\nAccount: ${job.facilityId}`,
      );
      progressMessages.set(job.id, { chatId, messageId: message.message_id });
    },
    onProgress: async (job, progress) => {
      const entry = progressMessages.get(job.id);
      const chatId = entry?.chatId || job.chatId || adminChatId();
      if (!chatId) {
        return;
      }
      const text =
        `Job ${job.id}\n` +
        `Account: ${job.facilityId}\n` +
        `Progress: ${progress.done}/${progress.total}\n` +
        `Success: ${progress.success}\n` +
        `Last: ${progress.row?.["Individual ID"] || "-"}`;
      try {
        if (entry?.messageId) {
          await bot.api.editMessageText(chatId, entry.messageId, text);
        } else {
          const message = await bot.api.sendMessage(chatId, text);
          progressMessages.set(job.id, { chatId, messageId: message.message_id });
        }
      } catch (error) {
        if (!`${error.message}`.includes("message is not modified")) {
          logger.warn(`Progress update failed: ${error.message}`);
        }
      }
    },
    onJobFinished: async (job, { reportPath }) => {
      const entry = progressMessages.get(job.id);
      const chatId = entry?.chatId || job.chatId || adminChatId();
      progressMessages.delete(job.id);
      if (!chatId) {
        return;
      }
      await bot.api.sendMessage(
        chatId,
        `Job ${job.id} completed\nSuccess entries: ${job.successRows}/${job.totalRows}`,
      );
      if (reportPath) {
        await bot.api.sendDocument(chatId, new InputFile(reportPath), {
          caption: `Report for ${job.id}`,
        });
      }
    },
    onJobFailed: async (job, error) => {
      const entry = progressMessages.get(job.id);
      const chatId = entry?.chatId || job.chatId || adminChatId();
      progressMessages.delete(job.id);
      if (chatId) {
        await bot.api.sendMessage(chatId, `Job ${job.id} failed: ${error.message}`);
      }
    },
    onAuthRequired: async (job, error) => {
      const chatId = job.chatId || adminChatId();
      if (chatId) {
        const message =
          `Job ${job.id} paused: account ${job.facilityId} needs login.\n` +
          `Run /login ${job.facilityId} to continue.`;
        await bot.api.sendMessage(chatId, message);
      }
      notifyAuthRequired(job.facilityId, error);
    },
  };

  const worker = createWorker({ storage, tokenManager, config, logger, notifier });

  const buildCaptchaResolvers = (facilityId, adminId) => {
    const requestCaptchaText = async ({ image, attempt }) => {
      const promise = waitForText(adminId, config.captchaReplyTimeoutMs);
      await bot.api.sendPhoto(
        adminId,
        new InputFile(image, "captcha.jpg"),
        {
          caption:
            `Captcha for ${facilityId} (attempt ${attempt}/${config.maxCaptchaAttempts}).\n` +
            "Reply with the code. Send /cancel to abort.",
        },
      );
      return promise;
    };

    const requestOtp = async ({ username }) => {
      await bot.api.sendMessage(
        adminId,
        `MFA OTP required for ${username}. Enter the OTP sent to the registered mobile.`,
      );
      return waitForText(adminId, config.captchaReplyTimeoutMs);
    };

    return { requestCaptchaText, requestOtp };
  };

  const runLogin = async (facilityId, adminId) => {
    const facility = storage.getFacility(facilityId);
    if (!facility) {
      throw new Error(`Unknown username: ${facilityId}`);
    }
    const resolvers = buildCaptchaResolvers(facilityId, adminId);
    const result = await tokenManager.login(facilityId, resolvers);
    authNoticeAt.delete(facilityId);
    const requeued = storage.requeueAuthRequiredJobs(facilityId);
    return { result, requeued };
  };

  const beginLogin = (ctx, facilityId) => {
    const adminId = ctx.from.id;
    runLogin(facilityId, adminId)
      .then(async ({ result, requeued }) => {
        await ctx.reply(
          `Login successful: ${result.displayName || facilityId}\n` +
            (requeued ? `Requeued ${requeued} paused job(s).` : "Session ready."),
        );
      })
      .catch(async (error) => {
        logger.error(error);
        await ctx
          .reply(
            `Login failed: ${error.message}\n` +
              `Retry with /login ${facilityId}`,
          )
          .catch(() => {});
      });
  };

  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (!text || !ctx.from) {
      return next();
    }
    const pending = pendingText.get(`${ctx.from.id}`);
    if (!pending) {
      return next();
    }
    if (text.startsWith("/cancel")) {
      pending.reject(new Error("Cancelled by admin"));
      return next();
    }
    await safeDelete(ctx);
    pending.resolve(text.trim());
    return undefined;
  });

  const helpFor = (ctx) =>
    helpText({
      isAdmin: isAdmin(ctx.from?.id),
      isAllowedUser: isActiveAllowedUser(actorId(ctx)),
    });

  bot.command("start", async (ctx) => {
    await ctx.reply(helpFor(ctx), { parse_mode: "HTML" });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(helpFor(ctx), { parse_mode: "HTML" });
  });

  bot.command("cancel", async (ctx) => {
    const key = `${ctx.from?.id}`;
    const wizardKey = `${ctx.chat.id}:${ctx.from?.id}`;
    const hadOnboarding = onboarding.delete(key);
    const hadRunWizard = runWizard.delete(wizardKey);
    const pending = pendingText.get(key);
    if (pending) {
      pending.reject(new Error("Cancelled by admin"));
    }
    await ctx.reply(
      hadOnboarding || hadRunWizard || pending ? "Cancelled." : "Nothing to cancel.",
    );
  });

  bot.command("onboard", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Run /onboard in a private chat with the bot.");
      return;
    }
    if (onboarding.has(`${ctx.from.id}`)) {
      await ctx.reply("Finish or /cancel the current onboarding first.");
      return;
    }
    const username = (ctx.match || "").trim().split(/\s+/)[0];
    const key = `${ctx.from.id}`;
    if (!username) {
      onboarding.set(key, { stage: "username", facilityId: null, username: null });
      await ctx.reply(
        "Send the portal username. It will also be used as the account ID, and I will delete the message after reading it.",
      );
      return;
    }
    if (!isValidIdentifier(username)) {
      await ctx.reply(
        "Usage: /onboard <username>\nExample: /onboard 124-cho176533",
      );
      return;
    }
    if (!canOnboardFacility(ctx, storage.getFacility(username))) {
      await ctx.reply("This account already exists. Ask an admin to update it.");
      return;
    }
    onboarding.set(key, {
      facilityId: username,
      username,
      stage: "password",
    });
    await ctx.reply(
      `Onboarding "${username}".\nSend the portal password. I will delete it immediately after reading.`,
    );
  });

  bot.command("login", async (ctx) => {
    const facilityId = (ctx.match || "").trim().split(/\s+/)[0];
    if (!identifierPattern.test(facilityId)) {
      await ctx.reply("Usage: /login <username>");
      return;
    }
    const facility = storage.getFacility(facilityId);
    if (!canAccessFacility(ctx, facility)) {
      await ctx.reply("Account not found.");
      return;
    }
    await ctx.reply(`Logging in ${facilityId}...`);
    beginLogin(ctx, facilityId);
  });

  bot.command("remove", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Run /remove in a private chat with the bot.");
      return;
    }

    const parts = (ctx.match || "").trim().split(/\s+/).filter(Boolean);
    const username = parts[0];
    const usage =
      `Usage: /remove <username>\n` +
      `Then either:\n` +
      `  /remove <username> confirm       (account only)\n` +
      `  /remove <username> all confirm   (full local purge)`;

    if (!identifierPattern.test(username || "")) {
      await ctx.reply(usage);
      return;
    }

    const facility = storage.getFacility(username);
    if (!canAccessFacility(ctx, facility)) {
      await ctx.reply("Account not found.");
      return;
    }

    const stats = storage.getFacilityJobStats(username);
    const active = stats.queued + stats.running;
    if (active > 0) {
      await ctx.reply(
        `Cannot remove ${username}: ${active} job(s) are queued or running.\n` +
          "Wait for them to finish, then try again.",
      );
      return;
    }

    const modeToken = (parts[1] || "").toLowerCase();
    const confirmToken = (parts[2] || "").toLowerCase();
    if (modeToken && !["all", "confirm"].includes(modeToken)) {
      await ctx.reply(usage);
      return;
    }
    if (parts[3]) {
      await ctx.reply(usage);
      return;
    }
    if (modeToken === "confirm" && confirmToken) {
      await ctx.reply(usage);
      return;
    }

    const summary = [
      `Account: ${username}`,
      `Jobs: ${stats.total} (queued ${stats.queued}, running ${stats.running}, paused ${stats.auth_required}, completed ${stats.completed}, failed ${stats.failed})`,
      `Saved row results: ${stats.rows}`,
    ].join("\n");

    if (!modeToken) {
      await ctx.reply(
        `${summary}\n\n` +
          `Remove the account only (credentials and tokens)?\n` +
          `Send: /remove ${username} confirm\n\n` +
          `To delete jobs, row results, events, and local files instead:\n` +
          `Send: /remove ${username} all`,
      );
      return;
    }

    if (modeToken === "all" && confirmToken !== "confirm") {
      await ctx.reply(
        `${summary}\n\n` +
          `Full purge will delete:\n` +
          `- credentials and tokens\n` +
          `- ${stats.total} job(s), ${stats.rows} saved row result(s), ${stats.events} event(s)\n` +
          `- imported, prepared, and report files under DATA_DIR\n\n` +
          `This does not delete records already submitted to the NCD portal.\n` +
          `Send: /remove ${username} all confirm`,
      );
      return;
    }

    const mode = modeToken === "all" ? "all" : "account";
    try {
      const result = await removeFacility({
        storage,
        config,
        facilityId: username,
        mode,
        logger,
      });
      const lines = [`Removed account ${username}.`];
      if (mode === "all") {
        lines.push(
          `Deleted ${result.jobsDeleted} job(s), ${stats.rows} row result(s), and ${stats.events} event(s).`,
        );
        lines.push(`Removed ${result.filesRemoved.length} local file path(s).`);
        if (result.filesSkipped.length > 0) {
          lines.push(`Skipped ${result.filesSkipped.length} unmanaged path(s).`);
        }
      } else if (stats.auth_required > 0) {
        lines.push(
          `Note: ${stats.auth_required} paused job(s) remain and cannot resume without re-onboarding.`,
        );
      }
      await ctx.reply(lines.join("\n"));
    } catch (error) {
      logger.error(error);
      await ctx.reply(`Could not remove ${username}: ${error.message}`);
    }
  });

  bot.command("facilities", async (ctx) => {
    if (isAdmin(ctx.from?.id)) {
      const userIds = activeOwnerIds();
      if (userIds.length === 0) {
        await ctx.reply("No active allowed users configured.");
        return;
      }
      const lines = ["👥 Active allowed users"];
      for (const userId of userIds) {
        const facilities = storage.listFacilities({ ownerId: userId });
        lines.push(`\n👤 ${userId}`);
        if (facilities.length === 0) {
          lines.push("   • No accounts");
          continue;
        }
        for (const facility of facilities) {
          lines.push(
            `   • ${facility.id}: ${facility.displayName || facility.username} [${facility.authStatus}]`,
          );
        }
      }
      await ctx.reply(lines.join("\n"));
      return;
    }

    const facilities = storage.listFacilities({ ownerId: actorId(ctx) });
    if (facilities.length === 0) {
      await ctx.reply("You have no accounts yet. Use /onboard <username>.");
      return;
    }
    const lines = facilities.map(
      (facility) =>
        `- ${facility.id}: ${facility.displayName || facility.username} [${facility.authStatus}]`,
    );
    await ctx.reply(lines.join("\n"));
  });

  bot.command("jobs", async (ctx) => {
    const facilityId = (ctx.match || "").trim().split(/\s+/)[0];
    if (facilityId && !identifierPattern.test(facilityId)) {
      await ctx.reply("Usage: /jobs [username]");
      return;
    }
    if (
      facilityId &&
      !canAccessFacility(ctx, storage.getFacility(facilityId))
    ) {
      await ctx.reply("Account not found.");
      return;
    }

    const admin = isAdmin(ctx.from?.id);
    if (admin && activeOwnerIds().length === 0) {
      await ctx.reply("No active allowed users configured.");
      return;
    }

    const jobs = storage.listJobs({
      limit: 10,
      facilityId: facilityId || undefined,
      ...(admin
        ? { ownerIds: activeOwnerIds() }
        : { ownerId: actorId(ctx) }),
    });
    if (jobs.length === 0) {
      await ctx.reply(
        facilityId ? `No jobs found for ${facilityId}.` : "No jobs yet.",
      );
      return;
    }

    const title = facilityId
      ? `📋 <b>Jobs for ${facilityId}</b>`
      : admin
        ? "📋 <b>Active users' recent jobs</b>"
        : "📋 <b>Your recent jobs</b>";
    const blocks = jobs.map((job) => {
      const status = getJobStatusMeta(job.status);
      const started = job.startedAt
        ? formatJobTime(job.startedAt)
        : `not started · created ${formatJobTime(job.createdAt)}`;
      const owner = admin ? ` · user ${job.ownerId}` : "";
      return (
        `${status.icon} <code>${job.id}</code> · <b>${status.label}</b>\n` +
        `   ${job.facilityId}${owner} · ${started}\n` +
        `   ${formatCount(job.doneRows)}/${formatCount(job.totalRows)} entries`
      );
    });

    await ctx.reply(`${title}\n\n${blocks.join("\n\n")}`, {
      parse_mode: "HTML",
    });
  });

  bot.command("job", async (ctx) => {
    const jobId = (ctx.match || "").trim().split(/\s+/)[0];
    const job = storage.getJob(jobId);
    if (!canAccessJob(ctx, job)) {
      await ctx.reply("Job not found.");
      return;
    }
    const status = getJobStatusMeta(job.status);
    await ctx.reply(
      [
        `📄 <b>${escapeHtml(job.id)}</b>`,
        `${status.icon} <b>${status.label}</b> · ${escapeHtml(job.facilityId)}`,
        isAdmin(ctx.from?.id) && job.ownerId
          ? `User: ${escapeHtml(job.ownerId)}`
          : null,
        "",
        `<b>Progress:</b> ${formatCount(job.doneRows)}/${formatCount(job.totalRows)}`,
        `<b>Success:</b> ${formatCount(job.successRows)}`,
        `<b>Started:</b> ${formatJobTime(job.startedAt)}`,
        `<b>Created:</b> ${formatJobTime(job.createdAt)}`,
        job.error ? `\n❌ <b>Error:</b> ${escapeHtml(job.error)}` : null,
      ]
        .filter((line) => line !== null)
        .join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("report", async (ctx) => {
    const jobId = (ctx.match || "").trim().split(/\s+/)[0];
    if (!jobId) {
      await ctx.reply("Usage: /report <job-id>");
      return;
    }
    const job = storage.getJob(jobId);
    if (!canAccessJob(ctx, job)) {
      await ctx.reply("Job not found.");
      return;
    }
    if (job.status !== "completed") {
      await ctx.reply(`Report is only available for completed jobs (status: ${job.status}).`);
      return;
    }
    if (!job.reportPath) {
      await ctx.reply(`No report is stored for ${job.id}.`);
      return;
    }

    try {
      await fs.access(job.reportPath);
    } catch {
      await ctx.reply(`Report file not found for ${job.id}.`);
      return;
    }

    await bot.api.sendDocument(ctx.chat.id, new InputFile(job.reportPath), {
      caption:
        `Report for ${job.id}\n` +
        `Account: ${job.facilityId}\n` +
        `Success entries: ${job.successRows}/${job.totalRows}`,
    });
  });

  const createJobFromDocument = async (
    ctx,
    document,
    caption,
    parsedOverride = null,
  ) => {
    const parsed = parsedOverride || parseJobMessage(caption);
    if (!parsed) {
      await ctx.reply(
        "Usage: /run username=<username> entriesPerDate=200 concurrency=5\nAttach an .xlsx file.",
      );
      return;
    }

    const facility = storage.getFacility(parsed.facilityId);
    if (!canAccessFacility(ctx, facility)) {
      await ctx.reply(`Unknown username: ${parsed.facilityId}. Run /onboard first.`);
      return;
    }
    if (facility.authStatus !== "ok" && !parsed.params.dryRun) {
      await ctx.reply(
        `Account ${parsed.facilityId} needs login. Run /login ${parsed.facilityId}.`,
      );
      return;
    }

    let fileName;
    try {
      fileName = resolveSheetFileName(parsed.facilityId, document.file_name);
    } catch (error) {
      await ctx.reply(error.message);
      return;
    }

    if (document.file_size && document.file_size > config.maxDownloadBytes) {
      await ctx.reply("File is too large. Telegram limit is 20 MB.");
      return;
    }

    const jobId = `job-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const jobDir = path.join(config.importDir, jobId);
    await fs.mkdir(jobDir, { recursive: true });

    const file = await ctx.api.getFile(document.file_id);
    if (!file.file_path) {
      throw new Error("Telegram did not return a file path");
    }
    const response = await fetch(
      `https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`,
    );
    if (!response.ok) {
      throw new Error(`File download failed: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > config.maxDownloadBytes) {
      await ctx.reply("File is too large. Telegram limit is 20 MB.");
      return;
    }

    const inputPath = path.join(jobDir, fileName);
    await fs.writeFile(inputPath, buffer);

    const outputDir = path.join(config.outputDir, parsed.facilityId, jobId);
    const job = storage.createJob({
      id: jobId,
      facilityId: parsed.facilityId,
      ownerId: facility.ownerId || actorId(ctx),
      chatId: `${ctx.chat.id}`,
      messageId: ctx.message.message_id,
      inputPath,
      outputDir,
      params: parsed.params,
    });
    storage.addEvent({
      jobId: job.id,
      facilityId: job.facilityId,
      message: `Job queued from chat ${ctx.chat.id}`,
    });

    let entries = null;
    try {
      entries = readExcelFile(inputPath).length;
    } catch (error) {
      logger.warn(`Could not count rows for ${job.id}: ${error.message}`);
    }
    await notifyUsers(
      config.adminIds,
      `🆕 New job queued\n` +
        `Account: ${job.facilityId}\n` +
        `Entries: ${entries === null ? "unknown" : formatCount(entries)}\n` +
        `User: ${actorId(ctx)}\n` +
        `Job: ${job.id}`,
    );

    await ctx.reply(
      `Queued ${job.id} for ${job.facilityId} (sheet saved as ${fileName}).`,
    );
  };

  const runKey = (ctx) => `${ctx.chat.id}:${ctx.from?.id}`;

  const sendWizardMessage = async (ctx, text, keyboard = null) => {
    const options = {
      reply_markup: keyboard || { inline_keyboard: [] },
    };
    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageText(text, options);
        return;
      } catch {
        // Fall back to a new message if the original cannot be edited.
      }
    }
    await ctx.reply(text, options);
  };

  const entriesKeyboard = () =>
    new InlineKeyboard()
      .text("100", "run:e:100")
      .text("200", "run:e:200")
      .row()
      .text("500", "run:e:500")
      .text("All (0)", "run:e:0")
      .row()
      .text("Cancel", "run:cancel");

  const concurrencyKeyboard = () =>
    new InlineKeyboard()
      .text("1", "run:n:1")
      .text("3", "run:n:3")
      .text("5", "run:n:5")
      .row()
      .text("Cancel", "run:cancel");

  const buildWizardJob = (session) => ({
    facilityId: session.facilityId,
    params: {
      ...session.params,
      entriesPerDate:
        session.entriesPerDate ?? session.params?.entriesPerDate ?? 0,
      concurrency:
        session.concurrency ?? session.params?.concurrency ?? config.defaultConcurrency,
    },
  });

  const startRunWizard = async (ctx, { document = null, parsed = null } = {}) => {
    if (!parsed) {
      await ctx.reply(
        "Usage: /run <username>\nExample: /run 124-cho176533",
      );
      return;
    }

    const facility = storage.getFacility(parsed.facilityId);
    if (!canAccessFacility(ctx, facility)) {
      await ctx.reply(`Unknown username: ${parsed.facilityId}. Run /onboard first.`);
      return;
    }

    const session = {
      facilityId: parsed.facilityId,
      params: { ...parsed.params },
      entriesPerDate: parsed.params.entriesPerDate,
      concurrency: parsed.params.concurrency,
      document,
    };
    const key = runKey(ctx);
    runWizard.set(key, session);

    if (session.entriesPerDate === undefined) {
      session.stage = "entries";
      await sendWizardMessage(
        ctx,
        `Account: ${facility.displayName || facility.username}\nHow many entries per processing date?`,
        entriesKeyboard(),
      );
      return;
    }

    if (session.concurrency === undefined) {
      session.stage = "concurrency";
      await sendWizardMessage(
        ctx,
        `Account: ${facility.displayName || facility.username}\nHow many entries should be processed at the same time?`,
        concurrencyKeyboard(),
      );
      return;
    }

    await finishRunWizard(ctx, session);
  };

  const finishRunWizard = async (ctx, session) => {
    if (session.document) {
      runWizard.delete(runKey(ctx));
      await sendWizardMessage(ctx, `Starting ${session.facilityId}...`);
      try {
        await createJobFromDocument(
          ctx,
          session.document,
          null,
          buildWizardJob(session),
        );
      } catch (error) {
        logger.error(error);
        await ctx.reply(`Could not start job: ${error.message}`);
      }
      return;
    }

    session.stage = "file";
    await sendWizardMessage(
      ctx,
      `Send the .xlsx file for ${session.facilityId}.`,
      new InlineKeyboard().text("Cancel", "run:cancel"),
    );
  };

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("run:")) {
      return;
    }

    const key = runKey(ctx);
    const session = runWizard.get(key);
    await ctx.answerCallbackQuery().catch(() => {});

    if (data === "run:cancel") {
      runWizard.delete(key);
      await sendWizardMessage(ctx, "Run cancelled.");
      return;
    }

    if (!session) {
      await sendWizardMessage(ctx, "Start again with /run.");
      return;
    }

    if (data.startsWith("run:e:")) {
      if (session.stage !== "entries") {
        return;
      }
      session.entriesPerDate = Number.parseInt(data.slice("run:e:".length), 10);
      if (session.concurrency !== undefined) {
        await finishRunWizard(ctx, session);
        return;
      }
      session.stage = "concurrency";
      await sendWizardMessage(
        ctx,
        "How many entries should be processed at the same time?",
        concurrencyKeyboard(),
      );
      return;
    }

    if (data.startsWith("run:n:")) {
      if (session.stage !== "concurrency") {
        return;
      }
      session.concurrency = Number.parseInt(data.slice("run:n:".length), 10);
      await finishRunWizard(ctx, session);
    }
  });

  bot.on("message:document", async (ctx) => {
    const key = runKey(ctx);
    const session = runWizard.get(key);
    if (session) {
      if (session.stage !== "file") {
        await ctx.reply("Finish the /run options first, or send /cancel.");
        return;
      }
      runWizard.delete(key);
      try {
        await createJobFromDocument(
          ctx,
          ctx.message.document,
          null,
          buildWizardJob(session),
        );
      } catch (error) {
        logger.error(error);
        await ctx.reply(`Could not start job: ${error.message}`);
      }
      return;
    }

    const caption = ctx.message.caption || "";
    if (!/^\/run(\s|@|$)/i.test(caption)) {
      return;
    }
    try {
      const parsed = parseJobMessage(caption);
      await startRunWizard(ctx, {
        document: ctx.message.document,
        parsed,
      });
    } catch (error) {
      logger.error(error);
      await ctx.reply(`Could not start job: ${error.message}`);
    }
  });

  bot.command("run", async (ctx) => {
    const key = runKey(ctx);
    if (runWizard.has(key)) {
      await ctx.reply("Finish the current /run options first, or send /cancel.");
      return;
    }

    const document = ctx.message?.reply_to_message?.document || null;
    const raw = (ctx.match || "").trim();
    if (!raw) {
      await ctx.reply("Usage: /run <username>\nExample: /run 124-cho176533");
      return;
    }

    try {
      const parsed = parseJobMessage(`/run ${raw}`);
      await startRunWizard(ctx, { document, parsed });
    } catch (error) {
      logger.error(error);
      await ctx.reply(`Could not start job: ${error.message}`);
    }
  });

  bot.on("message:text", async (ctx) => {
    const key = `${ctx.from.id}`;
    const runSession = runWizard.get(runKey(ctx));
    if (runSession) {
      await ctx.reply(
        runSession.stage === "file"
          ? "Send the .xlsx file, or /cancel."
          : "Use the buttons above, or /cancel.",
      );
      return;
    }

    const session = onboarding.get(key);
    if (!session) {
      return;
    }

    const text = ctx.message.text.trim();
    if (session.stage === "username") {
      await safeDelete(ctx);
      if (!text) {
        await ctx.reply("Username cannot be empty. Send the portal username.");
        return;
      }
      if (!isValidIdentifier(text)) {
        await ctx.reply(
          "Invalid username. Use letters, numbers, hyphen, and underscore only.",
        );
        return;
      }
      if (!canOnboardFacility(ctx, storage.getFacility(text))) {
        await ctx.reply("This account already exists. Ask an admin to update it.");
        return;
      }
      session.username = text;
      session.facilityId = text;
      session.stage = "password";
      await ctx.reply("Send the portal password. I will delete it immediately after reading.");
      return;
    }

    if (session.stage === "password") {
      await safeDelete(ctx);
      onboarding.delete(key);
      const facilityId = session.facilityId;
      try {
        tokenManager.saveCredentials({
          facilityId,
          username: session.username,
          password: text,
          ownerId: actorId(ctx),
          isAdmin: isAdmin(ctx.from?.id),
        });
      } catch (error) {
        await ctx.reply(`Could not save credentials: ${error.message}`);
        return;
      }
      await ctx.reply(`Credentials saved. Starting login for ${facilityId}...`);
      beginLogin(ctx, facilityId);
    }
  });

  bot.catch((error) => {
    logger.error("Bot error", error.error || error);
  });

  const start = async () => {
    worker.start();
    tokenManager.startKeeper();
    const commands = [
      { command: "start", description: "Show help" },
      { command: "help", description: "Show help" },
      { command: "onboard", description: "Add your account (private chat)" },
      { command: "login", description: "Renew your account session" },
      { command: "remove", description: "Remove your account (private chat)" },
      { command: "facilities", description: "List your accounts" },
      { command: "jobs", description: "List your jobs, optional username" },
      { command: "job", description: "Show job status" },
      { command: "run", description: "Start a job step by step" },
      { command: "report", description: "Resend a completed job report" },
    ];
    await bot.api.setMyCommands(commands).catch(() => {});
    logger.info("Bot starting with long polling");
    await bot.start({
      allowed_updates: ["message", "callback_query"],
    });
  };

  const stop = async () => {
    tokenManager.stopKeeper();
    await worker.stop();
    await bot.stop();
    storage.close();
  };

  return { bot, storage, tokenManager, worker, start, stop };
};

const main = async () => {
  const app = await createBotApp();
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down`);
    try {
      await app.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection", reason);
  });
  await app.start();
};

if (require.main === module) {
  main().catch((error) => {
    logger.error(error);
    process.exit(1);
  });
}

module.exports = { createBotApp };
