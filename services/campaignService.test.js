import test from "node:test";
import assert from "node:assert/strict";

function buildCsv(rows, headers = ["email", "name", "company"]) {
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(row.join(","));
  }
  return Buffer.from(lines.join("\n"));
}

async function loadCampaignService({ csvMaxColumns } = {}) {
  const previousCsvMaxColumns = process.env.CSV_MAX_COLUMNS;

  try {
    if (csvMaxColumns === undefined) {
      delete process.env.CSV_MAX_COLUMNS;
    } else {
      process.env.CSV_MAX_COLUMNS = String(csvMaxColumns);
    }

    const moduleUrl = new URL("./campaignService.js", import.meta.url);
    moduleUrl.searchParams.set("v", `${Date.now()}-${Math.random()}`);
    return await import(moduleUrl.href);
  } finally {
    if (previousCsvMaxColumns === undefined) {
      delete process.env.CSV_MAX_COLUMNS;
    } else {
      process.env.CSV_MAX_COLUMNS = previousCsvMaxColumns;
    }
  }
}

test("ingests a large CSV in batches without losing rows", async () => {
  const service = await loadCampaignService();
  const statusCalls = [];
  const batchCalls = [];

  service.__setCampaignServiceDeps({
    setCampaignImportStatus: async (...args) => {
      statusCalls.push(args);
    },
    batchInsertRecipients: async (_campaignId, recipients) => {
      batchCalls.push(recipients.length);
      return recipients.length;
    }
  });

  try {
    const rowCount = 10000;
    const rows = Array.from({ length: rowCount }, (_, index) => [
      `user${index}@example.com`,
      `User ${index}`,
      `Company ${index}`
    ]);

    const result = await service.ingestRecipientsFromCsvBuffer({
      campaignId: 42,
      csvBuffer: buildCsv(rows),
      batchSize: 1000
    });

    assert.equal(result.insertedCount, rowCount);
    assert.equal(result.invalidCount, 0);
    assert.equal(batchCalls.length, 10);
    assert.equal(batchCalls.every((count) => count === 1000), true);
    assert.equal(statusCalls[0][1], "processing");
    assert.equal(statusCalls.at(-1)[1], "completed");
    assert.equal(statusCalls.at(-1)[2], rowCount);
  } finally {
    service.__resetCampaignServiceDeps();
  }
});

test("ingests a heavier CSV load without losing rows", async () => {
  const service = await loadCampaignService();
  const statusCalls = [];
  let insertedRows = 0;

  service.__setCampaignServiceDeps({
    setCampaignImportStatus: async (...args) => {
      statusCalls.push(args);
    },
    batchInsertRecipients: async (_campaignId, recipients) => {
      insertedRows += recipients.length;
      return recipients.length;
    }
  });

  try {
    const rowCount = 50000;
    const rows = Array.from({ length: rowCount }, (_, index) => [
      `heavy${index}@example.com`,
      `Heavy ${index}`,
      `Load ${index}`
    ]);

    const result = await service.ingestRecipientsFromCsvBuffer({
      campaignId: 43,
      csvBuffer: buildCsv(rows),
      batchSize: 5000
    });

    assert.equal(result.insertedCount, rowCount);
    assert.equal(result.invalidCount, 0);
    assert.equal(insertedRows, rowCount);
    assert.equal(statusCalls.at(-1)[1], "completed");
  } finally {
    service.__resetCampaignServiceDeps();
  }
});

test("ingests a 100k row CSV load without losing rows", async () => {
  const service = await loadCampaignService();
  const statusCalls = [];
  let insertedRows = 0;

  service.__setCampaignServiceDeps({
    setCampaignImportStatus: async (...args) => {
      statusCalls.push(args);
    },
    batchInsertRecipients: async (_campaignId, recipients) => {
      insertedRows += recipients.length;
      return recipients.length;
    }
  });

  try {
    const rowCount = 100000;
    const rows = Array.from({ length: rowCount }, (_, index) => [
      `mega${index}@example.com`,
      `Mega ${index}`,
      `Scale ${index}`
    ]);

    const result = await service.ingestRecipientsFromCsvBuffer({
      campaignId: 44,
      csvBuffer: buildCsv(rows),
      batchSize: 10000
    });

    assert.equal(result.insertedCount, rowCount);
    assert.equal(result.invalidCount, 0);
    assert.equal(insertedRows, rowCount);
    assert.equal(statusCalls.at(-1)[1], "completed");
  } finally {
    service.__resetCampaignServiceDeps();
  }
});

test("ingests a mixed-validity 50k row CSV load without losing rows", async () => {
  const service = await loadCampaignService();
  const statusCalls = [];
  let insertedRows = 0;

  service.__setCampaignServiceDeps({
    setCampaignImportStatus: async (...args) => {
      statusCalls.push(args);
    },
    batchInsertRecipients: async (_campaignId, recipients) => {
      insertedRows += recipients.length;
      return recipients.length;
    }
  });

  try {
    const rowCount = 50000;
    let expectedValid = 0;
    let expectedInvalid = 0;
    const rows = Array.from({ length: rowCount }, (_, index) => {
      if (index % 10 === 0) {
        expectedInvalid += 1;
        return [
          `not-an-email-${index}`,
          `Bad ${index}`,
          `Broken ${index}`
        ];
      }

      expectedValid += 1;
      return [
        `mixed${index}@example.com`,
        `Mixed ${index}`,
        `Scale ${index}`
      ];
    });

    const result = await service.ingestRecipientsFromCsvBuffer({
      campaignId: 45,
      csvBuffer: buildCsv(rows),
      batchSize: 5000
    });

    assert.equal(result.insertedCount, expectedValid);
    assert.equal(result.invalidCount, expectedInvalid);
    assert.equal(insertedRows, expectedValid);
    assert.equal(statusCalls.at(-1)[1], "completed");
  } finally {
    service.__resetCampaignServiceDeps();
  }
});

test("ingests BOM and whitespace padded headers correctly", async () => {
  const service = await loadCampaignService();
  const inserted = [];
  const statusCalls = [];

  service.__setCampaignServiceDeps({
    setCampaignImportStatus: async (...args) => {
      statusCalls.push(args);
    },
    batchInsertRecipients: async (_campaignId, recipients) => {
      inserted.push(...recipients);
      return recipients.length;
    }
  });

  try {
    const csvBuffer = Buffer.from(
      `\uFEFF  E-mail  ,   Full Name  ,  Organization  \n` +
      `bom.user@example.com, BOM User, BOM Co\n` +
      `second.user@example.com, Second User, Second Co`
    );

    const result = await service.ingestRecipientsFromCsvBuffer({
      campaignId: 46,
      csvBuffer,
      batchSize: 100
    });

    assert.equal(result.insertedCount, 2);
    assert.equal(result.invalidCount, 0);
    assert.equal(inserted.length, 2);
    assert.equal(inserted[0].email, "bom.user@example.com");
    assert.equal(inserted[0].name, "BOM User");
    assert.equal(inserted[0].company, "BOM Co");
    assert.equal(inserted[1].email, "second.user@example.com");
    assert.equal(inserted[1].name, "Second User");
    assert.equal(inserted[1].company, "Second Co");
    assert.equal(statusCalls.at(-1)[1], "completed");
  } finally {
    service.__resetCampaignServiceDeps();
  }
});

test("normalizes case-insensitive headers and skips invalid rows", async () => {
  const service = await loadCampaignService();
  const inserted = [];
  const statusCalls = [];

  service.__setCampaignServiceDeps({
    setCampaignImportStatus: async (...args) => {
      statusCalls.push(args);
    },
    batchInsertRecipients: async (_campaignId, recipients) => {
      inserted.push(...recipients);
      return recipients.length;
    }
  });

  try {
    const csvBuffer = buildCsv(
      [
        ["valid.one@example.com", "Alpha One", "Acme"],
        ["not-an-email", "Broken", "Bad Co"],
        ["valid.two@example.com", "Beta Two", "Beta Inc"]
      ],
      ["E-Mail", "Full Name", "Organization"]
    );

    const result = await service.ingestRecipientsFromCsvBuffer({
      campaignId: 7,
      csvBuffer,
      batchSize: 2
    });

    assert.equal(result.insertedCount, 2);
    assert.equal(result.invalidCount, 1);
    assert.equal(inserted.length, 2);
    assert.equal(inserted[0].email, "valid.one@example.com");
    assert.equal(inserted[0].name, "Alpha One");
    assert.equal(inserted[0].company, "Acme");
    assert.equal(inserted[1].email, "valid.two@example.com");
    assert.equal(inserted[1].name, "Beta Two");
    assert.equal(inserted[1].company, "Beta Inc");
    assert.equal(statusCalls.at(-1)[1], "completed");
  } finally {
    service.__resetCampaignServiceDeps();
  }
});

test("rejects csv files that exceed the configured column limit", async () => {
  const service = await loadCampaignService({ csvMaxColumns: 3 });
  const statusCalls = [];

  service.__setCampaignServiceDeps({
    setCampaignImportStatus: async (...args) => {
      statusCalls.push(args);
    },
    batchInsertRecipients: async () => 0
  });

  try {
    const csvBuffer = buildCsv(
      [["user@example.com", "User", "Acme", "extra"]],
      ["email", "name", "company", "department"]
    );

    await assert.rejects(
      service.ingestRecipientsFromCsvBuffer({
        campaignId: 9,
        csvBuffer,
        batchSize: 100
      }),
      /too many columns/i
    );

    assert.equal(statusCalls[0][1], "processing");
    assert.equal(statusCalls.at(-1)[1], "failed");
  } finally {
    service.__resetCampaignServiceDeps();
  }
});

test("rejects downstream batch insert failure and marks import failed", async () => {
  const service = await loadCampaignService();
  const statusCalls = [];

  service.__setCampaignServiceDeps({
    setCampaignImportStatus: async (...args) => {
      statusCalls.push(args);
    },
    batchInsertRecipients: async () => {
      throw new Error("database write failed");
    }
  });

  try {
    const csvBuffer = buildCsv([["user@example.com", "User", "Acme"]]);

    await assert.rejects(
      service.ingestRecipientsFromCsvBuffer({
        campaignId: 11,
        csvBuffer,
        batchSize: 100
      }),
      /database write failed/
    );

    assert.equal(statusCalls[0][1], "processing");
    assert.equal(statusCalls.at(-1)[1], "failed");
  } finally {
    service.__resetCampaignServiceDeps();
  }
});
