import { getAccessToken } from './auth';

export interface SheetRowData {
  timestamp: string;
  serialNumber: string;
  macLan: string;
  macWifi: string;
  qrContent: string;
  assetTag?: string;
  company?: string;
  partNumber?: string;
  model?: string;
  salesModelName?: string;
  licenseKey?: string;
  allBarcodesSummary?: string;
  notes?: string;
  operator?: string;
}

export const DEFAULT_SHEET_TITLE = 'Sổ Quét QR & Barcode Thiết Bị';
export const DEFAULT_TAB_NAME = 'LichSuQuet';

// Bảng tính chỉ gồm đúng 5 cột A -> E (Đã bỏ cột Serial Number và các cột G->L)
export const STANDARD_HEADERS = [
  'Thời gian quét',         // Cột A
  'MAC Address (LAN)',       // Cột B
  'MAC Address (WiFi)',      // Cột C
  'Mã QR Code 1',            // Cột D
  'Mã QR Code 2',            // Cột E
];

/**
 * Creates a brand new Google Spreadsheet configured with standard headers (5 columns A to E)
 */
export async function createNewSpreadsheet(title: string = DEFAULT_SHEET_TITLE) {
  const token = await getAccessToken();
  if (!token) throw new Error('Vui lòng đăng nhập Google để tạo bảng tính');

  const now = new Date();
  const dateStr = now.toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const fullTitle = `${title} (${dateStr} ${timeStr})`;

  const payload = {
    properties: {
      title: fullTitle,
    },
    sheets: [
      {
        properties: {
          title: DEFAULT_TAB_NAME,
          gridProperties: {
            frozenRowCount: 1,
            rowCount: 1000,
            columnCount: 5,
          },
        },
        data: [
          {
            startRow: 0,
            startColumn: 0,
            rowData: [
              {
                values: STANDARD_HEADERS.map((h) => ({
                  userEnteredValue: { stringValue: h },
                })),
              },
            ],
          },
        ],
      },
    ],
  };

  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    console.error('Lỗi tạo Google Sheet:', errorData);
    throw new Error(errorData.error?.message || `Không thể tạo Google Sheet: HTTP ${res.status}`);
  }

  const data = await res.json();
  const spreadsheetId = data.spreadsheetId;
  const spreadsheetUrl = data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  // Apply styling to header row (bold, dark navy background, white text)
  try {
    const firstSheetId = data.sheets?.[0]?.properties?.sheetId || 0;
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          {
            repeatCell: {
              range: {
                sheetId: firstSheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: 5,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.08, green: 0.14, blue: 0.24 },
                  textFormat: {
                    bold: true,
                    foregroundColor: { red: 1.0, green: 1.0, blue: 1.0 },
                    fontSize: 10,
                  },
                  horizontalAlignment: 'CENTER',
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
            },
          },
        ],
      }),
    });
  } catch (styleErr) {
    console.warn('Không áp dụng được kiểu header (bỏ qua):', styleErr);
  }

  return {
    id: spreadsheetId,
    url: spreadsheetUrl,
    title: fullTitle,
    tabName: DEFAULT_TAB_NAME,
    sheetId: data.sheets?.[0]?.properties?.sheetId || 0,
  };
}

/**
 * Get spreadsheet details: title, tabs, URL
 */
export async function getSpreadsheetDetails(spreadsheetId: string) {
  const token = await getAccessToken();
  if (!token) throw new Error('Vui lòng đăng nhập Google');

  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Không tìm thấy bảng tính: HTTP ${res.status}`);
  }

  const data = await res.json();
  const sheets = (data.sheets || []).map((s: any) => ({
    sheetId: s.properties?.sheetId || 0,
    title: s.properties?.title || 'Sheet1',
    rowCount: s.properties?.gridProperties?.rowCount || 0,
  }));

  return {
    id: spreadsheetId,
    title: data.properties?.title || 'Untitled Spreadsheet',
    sheets,
    url: data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  };
}

/**
 * Fetch rows from a spreadsheet tab in real-time
 */
export async function fetchSheetRows(
  spreadsheetId: string,
  tabName?: string
): Promise<{ rows: string[][]; tabName: string }> {
  const token = await getAccessToken();
  if (!token) throw new Error('Vui lòng đăng nhập Google');

  let resolvedTab = tabName || '';
  if (!resolvedTab) {
    const details = await getSpreadsheetDetails(spreadsheetId);
    resolvedTab = details.sheets[0]?.title || 'Sheet1';
  }

  const escapedTab = `'${resolvedTab.replace(/'/g, "''")}'`;
  const range = encodeURIComponent(`${escapedTab}!A1:F500`);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Không thể tải dữ liệu: HTTP ${res.status}`);
  }

  const data = await res.json();
  return {
    tabName: resolvedTab,
    rows: data.values || [],
  };
}

/**
 * Ensures a valid spreadsheet exists.
 * If preferredId is invalid, missing, deleted, or inaccessible ->
 * AUTOMATICALLY creates a brand new Google Spreadsheet!
 */
export async function getOrCreateValidSpreadsheet(preferredId: string | null): Promise<{
  id: string;
  title: string;
  tabName: string;
  isNewlyCreated: boolean;
}> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('Chưa đăng nhập tài khoản Google');
  }

  // 1. Kiểm tra xem file có sẵn còn tồn tại không
  if (preferredId) {
    try {
      const details = await getSpreadsheetDetails(preferredId);
      const tabName = details.sheets[0]?.title || DEFAULT_TAB_NAME;
      return {
        id: preferredId,
        title: details.title,
        tabName,
        isNewlyCreated: false,
      };
    } catch (err: any) {
      console.warn(`File Google Sheet cũ (${preferredId}) không tìm thấy hoặc bị xóa. Đang tạo file mới...`, err);
    }
  }

  // 2. Không thấy file -> Tự động tạo file Google Sheet mới ngay lập tức!
  const newSheet = await createNewSpreadsheet('Sổ Quét QR & Barcode Thiết Bị');
  return {
    id: newSheet.id,
    title: newSheet.title,
    tabName: newSheet.tabName,
    isNewlyCreated: true,
  };
}

/**
 * Updates or forces standard headers on a specific spreadsheet tab (Strict 5 columns: A to E, dropping Serial Number and G to L)
 */
export async function updateSpreadsheetHeaders(spreadsheetId: string, tabName?: string) {
  const token = await getAccessToken();
  if (!token) throw new Error('Vui lòng đăng nhập Google');

  const details = await getSpreadsheetDetails(spreadsheetId);
  const targetTabObj = details.sheets.find((s: any) => s.title === tabName) || details.sheets[0];
  const resolvedTab = targetTabObj?.title || DEFAULT_TAB_NAME;
  const sheetId = targetTabObj?.sheetId || 0;

  // 1. Cập nhật dòng tiêu đề 5 cột A -> E
  const range = encodeURIComponent(`'${resolvedTab.replace(/'/g, "''")}'!A1:E1`);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        range: `'${resolvedTab}'!A1:E1`,
        majorDimension: 'ROWS',
        values: [STANDARD_HEADERS],
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Không thể cập nhật cột: HTTP ${res.status}`);
  }

  // 2. Xóa sạch dữ liệu các cột từ F trở đi nếu còn sót
  try {
    const clearRange = encodeURIComponent(`'${resolvedTab.replace(/'/g, "''")}'!F1:Z1000`);
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${clearRange}:clear`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (clearErr) {
    console.warn('Clear range F:Z warning:', clearErr);
  }

  // 3. Cắt gọn số lượng cột của bảng tính về đúng 5 cột (A đến E)
  try {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId,
                gridProperties: {
                  columnCount: 5,
                },
              },
              fields: 'gridProperties.columnCount',
            },
          },
        ],
      }),
    });
  } catch (resizeErr) {
    console.warn('Resize gridProperties warning:', resizeErr);
  }
}

/**
 * Ensure the sheet tab has the standard header row if it is empty or has old removed headers
 */
async function ensureHeaderRowExists(spreadsheetId: string, tabName: string, token: string) {
  try {
    const checkRange = encodeURIComponent(`'${tabName.replace(/'/g, "''")}'!A1:Z1`);
    const checkRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${checkRange}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (checkRes.ok) {
      const data = await checkRes.json();
      const existingHeaders: string[] = data.values?.[0] || [];
      const isEmpty = !data.values || data.values.length === 0 || existingHeaders.length === 0;

      // Kiểm tra nếu tiêu đề có nhiều hơn 5 cột hoặc còn chứa cột Serial Number / cột đã bỏ
      const hasColumnsBeyondE = existingHeaders.length > 5;
      const hasOldRemovedHeaders = existingHeaders.some((h: string) => {
        const lower = (h || '').toLowerCase();
        return (
          lower.includes('serial') ||
          lower.includes('seri') ||
          lower.includes('s/n') ||
          lower.includes('mã qr code 3') ||
          lower.includes('mã qr code 4') ||
          lower.includes('mã tài sản') ||
          lower.includes('công ty') ||
          lower.includes('part number') ||
          lower.includes('model / dòng máy') ||
          lower.includes('bản quyền') ||
          lower.includes('ghi chú kỹ thuật') ||
          lower.includes('người quét')
        );
      });

      if (isEmpty || hasColumnsBeyondE || hasOldRemovedHeaders) {
        // Nâng cấp dòng tiêu đề: đúng 5 cột A -> E
        await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/'${tabName}'!A1:E1?valueInputOption=USER_ENTERED`,
          {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              range: `'${tabName}'!A1:E1`,
              majorDimension: 'ROWS',
              values: [STANDARD_HEADERS],
            }),
          }
        );

        // Xóa tiêu đề ở các cột từ F trở đi
        if (hasColumnsBeyondE || hasOldRemovedHeaders) {
          const clearRange = encodeURIComponent(`'${tabName.replace(/'/g, "''")}'!F1:Z1`);
          await fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${clearRange}:clear`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
            }
          ).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.warn('Lỗi kiểm tra dòng tiêu đề:', e);
  }
}

/**
 * Append scanned record to Google Sheet in real-time.
 * Automatically resolves actual tab name and ensures headers exist.
 * The QR code content is split by comma "," into columns D & E (strictly 5 columns A to E).
 */
export async function appendScannedRecord(
  spreadsheetId: string,
  tabName: string,
  record: SheetRowData
): Promise<{ updatedRange: string; updatedRows: number; resolvedTab: string }> {
  const token = await getAccessToken();
  if (!token) throw new Error('Vui lòng đăng nhập Google để đồng bộ bảng tính');

  // 1. Kiểm tra chi tiết bảng tính để lấy tên tab hợp lệ chính xác
  const details = await getSpreadsheetDetails(spreadsheetId);
  const existingTabs = details.sheets.map((s: { title: string }) => s.title);
  const resolvedTab = existingTabs.includes(tabName) ? tabName : existingTabs[0] || DEFAULT_TAB_NAME;

  // 2. Đảm bảo dòng tiêu đề tồn tại nếu tab đang trống hoặc nâng cấp từ format cũ
  await ensureHeaderRowExists(spreadsheetId, resolvedTab, token);

  // Tách chuỗi QR Code theo dấu phẩy ","
  const rawQr = (record.qrContent || record.assetTag || '').trim();
  let qrParts: string[] = [];
  if (rawQr) {
    qrParts = rawQr.split(',').map((part) => part.trim());
  }

  const qr1 = qrParts[0] || (rawQr ? rawQr : '');
  const qr2 = qrParts[1] || '';

  // Bảng tính chỉ gồm đúng 5 cột A -> E (Đã bỏ cột Serial Number và các cột G->L):
  // Cột A: Thời gian quét
  // Cột B: MAC Address (LAN)
  // Cột C: MAC Address (WiFi)
  // Cột D: Mã QR Code 1
  // Cột E: Mã QR Code 2
  const rowValues = [
    record.timestamp,
    record.macLan || '',
    record.macWifi || '',
    qr1,
    qr2,
  ];

  // 3. Gọi Google Sheets API values.append vào khoảng A:E
  const encodedTab = encodeURIComponent(`'${resolvedTab.replace(/'/g, "''")}'!A:E`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodedTab}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      majorDimension: 'ROWS',
      values: [rowValues],
    }),
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    console.error('Lỗi ghi dòng vào Google Sheet:', errorData);
    throw new Error(errorData.error?.message || `Lỗi ghi Google Sheet: HTTP ${res.status}`);
  }

  const data = await res.json();
  return {
    updatedRange: data.updates?.updatedRange || '',
    updatedRows: data.updates?.updatedRows || 1,
    resolvedTab,
  };
}

/**
 * List spreadsheets accessible by user in Drive
 */
export async function listUserSpreadsheets(): Promise<Array<{ id: string; name: string; modifiedTime: string; url: string }>> {
  const token = await getAccessToken();
  if (!token) return [];

  try {
    const query = encodeURIComponent("mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false");
    const url = `https://www.googleapis.com/drive/v3/files?q=${query}&orderBy=modifiedTime desc&pageSize=20&fields=files(id,name,modifiedTime,webViewLink)`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) return [];
    const data = await res.json();
    return (data.files || []).map((f: any) => ({
      id: f.id,
      name: f.name,
      modifiedTime: f.modifiedTime,
      url: f.webViewLink || `https://docs.google.com/spreadsheets/d/${f.id}/edit`,
    }));
  } catch {
    return [];
  }
}

/**
 * Delete a specific row in the sheet
 */
export async function deleteSheetRow(spreadsheetId: string, sheetId: number, rowIndex1Indexed: number) {
  const token = await getAccessToken();
  if (!token) throw new Error('Vui lòng đăng nhập Google');

  const zeroBasedIndex = rowIndex1Indexed - 1;
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: zeroBasedIndex,
              endIndex: zeroBasedIndex + 1,
            },
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Không thể xóa hàng: HTTP ${res.status}`);
  }

  return await res.json();
}

