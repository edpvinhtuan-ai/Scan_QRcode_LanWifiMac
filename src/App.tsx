/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Scan,
  FileSpreadsheet,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Volume2,
  VolumeX,
  LogOut,
  RefreshCw,
  Save,
  RotateCcw,
  Plus,
  Download,
  Zap,
  ShieldCheck,
  Sparkles,
  Copy,
  Check,
  X,
} from 'lucide-react';
import firebaseConfig from '../firebase-applet-config.json';
import { User } from 'firebase/auth';
import { initAuth, googleSignIn, getAccessToken, logout } from './services/auth';
import {
  appendScannedRecord,
  createNewSpreadsheet,
  getOrCreateValidSpreadsheet,
  fetchSheetRows,
  updateSpreadsheetHeaders,
} from './services/sheets';
import { CameraScanner } from './components/CameraScanner';
import { ScannedRecord } from './types';
import { triggerSyncConfetti, playErrorBeep, playSuccessBeep } from './utils/feedback';

interface DeviceCodes {
  serialNumber: string;
  macLan: string;
  macWifi: string;
  qrCode: string;
  partNumber?: string;
  model?: string;
  company?: string;
  licenseKey?: string;
  notes?: string;
}

const emptyCodes: DeviceCodes = {
  serialNumber: '',
  macLan: '',
  macWifi: '',
  qrCode: '',
  partNumber: '',
  model: '',
  company: '',
  licenseKey: '',
  notes: '',
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);

  // Active Google Spreadsheet state
  const [spreadsheetId, setSpreadsheetId] = useState<string | null>(() => {
    return localStorage.getItem('active_spreadsheet_id') || null;
  });
  const [spreadsheetTitle, setSpreadsheetTitle] = useState<string>(() => {
    return localStorage.getItem('active_spreadsheet_title') || 'Sổ Quét QR & Barcode Thiết Bị';
  });
  const [sheetTabName, setSheetTabName] = useState<string>(() => {
    return localStorage.getItem('active_sheet_tab') || 'LichSuQuet';
  });

  // Cached rows from the live Google Sheet for duplicate detection & viewing
  const [liveSheetRows, setLiveSheetRows] = useState<string[][]>([]);
  const [isLoadingRows, setIsLoadingRows] = useState<boolean>(false);

  // Toggles & Settings
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [autoSyncToSheet, setAutoSyncToSheet] = useState<boolean>(true);
  const [preventDuplicate, setPreventDuplicate] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'scan' | 'sheet'>('scan');

  // Bộ 4 mã của thiết bị hiện tại: Seri + MAC LAN + MAC WiFi + QRcode
  const [deviceCodes, setDeviceCodes] = useState<DeviceCodes>(emptyCodes);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);

  // Toast notification
  const [toast, setToast] = useState<{
    type: 'success' | 'error' | 'info';
    message: string;
  } | null>(null);

  // Bộ đếm thời gian tự động ghi sau khi quét nhiều mã
  const [autoSaveCountdown, setAutoSaveCountdown] = useState<number | null>(null);
  const autoSaveTimerRef = useRef<any>(null);
  const countdownIntervalRef = useRef<any>(null);
  const latestDeviceCodesRef = useRef<DeviceCodes>(deviceCodes);

  useEffect(() => {
    latestDeviceCodesRef.current = deviceCodes;
  }, [deviceCodes]);

  const cancelAutoSave = useCallback(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    setAutoSaveCountdown(null);
  }, []);

  // Recent scans in current session
  const [recentRecords, setRecentRecords] = useState<ScannedRecord[]>(() => {
    try {
      const saved = localStorage.getItem('scanner_recent_records');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const toastTimeoutRef = React.useRef<any>(null);
  const lastToastMsgRef = React.useRef<string>('');
  const lastToastTimeRef = React.useRef<number>(0);

  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const now = Date.now();
    // Chống nhảy pop up liên tục: nếu cùng nội dung trong 2.5s thì không lặp lại
    if (lastToastMsgRef.current === message && now - lastToastTimeRef.current < 2500) {
      return;
    }
    lastToastMsgRef.current = message;
    lastToastTimeRef.current = now;

    setToast({ message, type });
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current);
    }
    toastTimeoutRef.current = setTimeout(() => {
      setToast(null);
    }, 3200);
  }, []);

  const saveActiveSpreadsheet = useCallback((id: string, title: string, tab: string) => {
    setSpreadsheetId(id);
    setSpreadsheetTitle(title);
    setSheetTabName(tab);
    localStorage.setItem('active_spreadsheet_id', id);
    localStorage.setItem('active_spreadsheet_title', title);
    localStorage.setItem('active_sheet_tab', tab);
  }, []);

  // Đảm bảo có file Google Sheet hợp lệ; nếu không thấy file cũ thì TỰ ĐỘNG TẠO FILE MỚI
  const ensureSpreadsheetValid = useCallback(
    async (preferredId: string | null) => {
      try {
        const result = await getOrCreateValidSpreadsheet(preferredId);
        saveActiveSpreadsheet(result.id, result.title, result.tabName);
        if (result.isNewlyCreated) {
          showToast(`✨ Đã tự động tạo file Google Sheet mới: ${result.title}`, 'success');
        }
        return result;
      } catch (err: any) {
        console.warn('Lỗi kiểm tra Google Sheet:', err);
        return null;
      }
    },
    [saveActiveSpreadsheet]
  );

  // Nạp dữ liệu thực tế từ Google Sheet; nếu không thấy file cũ thì tự tạo file mới
  const reloadLiveSheetRows = useCallback(async () => {
    if (!user || !spreadsheetId) return;
    try {
      setIsLoadingRows(true);
      const res = await fetchSheetRows(spreadsheetId, sheetTabName);
      setLiveSheetRows(res.rows);
    } catch (err: any) {
      console.warn('Lỗi tải hàng Google Sheet:', err);
      const errMsg = (err.message || '').toLowerCase();
      if (
        errMsg.includes('404') ||
        errMsg.includes('not found') ||
        errMsg.includes('không tìm thấy') ||
        errMsg.includes('deleted')
      ) {
        showToast('⚠️ Không thấy file cũ. Đang tự tạo file Google Sheet mới...', 'info');
        try {
          const newSheet = await createNewSpreadsheet('Sổ Quét QR & Barcode Thiết Bị');
          saveActiveSpreadsheet(newSheet.id, newSheet.title, newSheet.tabName);
          const res = await fetchSheetRows(newSheet.id, newSheet.tabName).catch(() => ({ rows: [] }));
          setLiveSheetRows(res.rows);
          showToast(`✨ Đã tạo file Google Sheet mới: ${newSheet.title}`, 'success');
        } catch (createErr: any) {
          console.error('Lỗi tự tạo file mới:', createErr);
        }
      }
    } finally {
      setIsLoadingRows(false);
    }
  }, [user, spreadsheetId, sheetTabName, saveActiveSpreadsheet]);

  // Trạng thái phát hiện tên miền chưa cấp phép trên Firebase Auth (ví dụ deploy Netlify)
  const [unauthorizedDomain, setUnauthorizedDomain] = useState<string | null>(null);
  const [copiedDomain, setCopiedDomain] = useState<boolean>(false);

  // Google Login
  const handleGoogleSignIn = async () => {
    setIsLoggingIn(true);
    try {
      const res = await googleSignIn();
      if (res) {
        setUser(res.user);
        setUnauthorizedDomain(null);
        showToast(`Đã kết nối: ${res.user.displayName || res.user.email}`, 'success');
        await ensureSpreadsheetValid(spreadsheetId);
        await reloadLiveSheetRows();
      }
    } catch (err: any) {
      console.error('Lỗi đăng nhập Google:', err);
      const isUnauthorizedDomain =
        err.code === 'auth/unauthorized-domain' ||
        (err.message && err.message.includes('unauthorized-domain'));

      if (isUnauthorizedDomain) {
        const domain = window.location.hostname;
        setUnauthorizedDomain(domain);
        showToast(`⚠️ Tên miền "${domain}" chưa được cấp phép trong Firebase! Vui lòng làm theo hướng dẫn.`, 'error');
      } else {
        showToast(err.message || 'Đăng nhập Google thất bại', 'error');
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Khởi tạo Auth
  useEffect(() => {
    initAuth(
      (currentUser) => {
        setUser(currentUser);
        ensureSpreadsheetValid(spreadsheetId).then(() => {
          reloadLiveSheetRows();
        });
      },
      () => {
        setUser(null);
      }
    );
  }, []);

  // Tự động tải lại hàng khi đổi Sheet ID
  useEffect(() => {
    if (user && spreadsheetId) {
      reloadLiveSheetRows();
    }
  }, [user, spreadsheetId, reloadLiveSheetRows]);

  // Lưu lịch sử gần đây vào LocalStorage
  useEffect(() => {
    try {
      localStorage.setItem('scanner_recent_records', JSON.stringify(recentRecords.slice(0, 30)));
    } catch (e) {}
  }, [recentRecords]);

  // Kiểm tra trùng trong Sheet (Cột B: MAC LAN, Cột C: MAC WiFi, Cột D-E: QR Code)
  const checkDuplicate = (codes: DeviceCodes): { field: string; value: string; rowNum: number } | null => {
    if (!liveSheetRows || liveSheetRows.length <= 1) return null;

    const testMacLan = codes.macLan?.trim().toUpperCase();
    const testMacWifi = codes.macWifi?.trim().toUpperCase();
    const testQr = codes.qrCode?.trim().toUpperCase();

    for (let i = 1; i < liveSheetRows.length; i++) {
      const row = liveSheetRows[i];
      const rowMacLan = row[1]?.trim().toUpperCase();
      const rowMacWifi = row[2]?.trim().toUpperCase();

      if (testMacLan && rowMacLan && rowMacLan === testMacLan) {
        return { field: 'MAC LAN', value: testMacLan, rowNum: i + 1 };
      }
      if (testMacWifi && rowMacWifi && rowMacWifi === testMacWifi) {
        return { field: 'MAC WiFi', value: testMacWifi, rowNum: i + 1 };
      }
      if (testQr) {
        const qrParts = testQr.split(',').map((p) => p.trim());
        const firstPart = qrParts[0] || testQr;
        const rowQrMatches = row.slice(3, 5).some((cell) => {
          const c = (cell || '').trim().toUpperCase();
          return c && (c === testQr || c === firstPart);
        });
        if (rowQrMatches) {
          return { field: 'Mã QR Code', value: testQr, rowNum: i + 1 };
        }
      }
    }
    return null;
  };

  // Ghi bộ mã vào Google Sheet; TỰ ĐỘNG TẠO FILE MỚI NẾU KHÔNG THẤY FILE CŨ
  const saveCodesToGoogleSheet = async (codesToSave: DeviceCodes, isAutomatic: boolean = false): Promise<boolean> => {
    // 1. Kiểm tra trống: Nếu MAC LAN, MAC WiFi, QR Code đều trống -> Không ghi
    const isAllEmpty =
      !codesToSave.macLan?.trim() &&
      !codesToSave.macWifi?.trim() &&
      !codesToSave.qrCode?.trim();

    if (isAllEmpty) {
      if (!isAutomatic) {
        if (soundEnabled) playErrorBeep();
        showToast('⚠️ Vui lòng quét hoặc nhập mã trước khi ghi vào Google Sheet!', 'error');
      }
      return false;
    }

    // 2. Kiểm tra trùng nếu bật chế độ chặn trùng
    if (preventDuplicate) {
      const dup = checkDuplicate(codesToSave);
      if (dup) {
        if (soundEnabled) playErrorBeep();
        showToast(`⚠️ ĐÃ CÓ TRONG SHEET: ${dup.field} [${dup.value}] tại Hàng #${dup.rowNum}. Không ghi trùng!`, 'error');
        return false;
      }
    }

    // 3. Kiểm tra đăng nhập Google
    const token = await getAccessToken();
    if (!token || !user) {
      showToast('⚠️ Chưa kết nối Google: Mã đã nhận vào bảng tạm. Vui lòng bấm "Đăng nhập Google" ở trên để ghi vào Sheet.', 'info');
      return false;
    }

    let targetSheetId = spreadsheetId;
    let targetTab = sheetTabName;

    // 4. Nếu chưa có file nào -> Tự tạo file Google Sheet mới ngay!
    if (!targetSheetId) {
      try {
        setIsSyncing(true);
        const validSheet = await getOrCreateValidSpreadsheet(null);
        targetSheetId = validSheet.id;
        targetTab = validSheet.tabName;
        saveActiveSpreadsheet(validSheet.id, validSheet.title, validSheet.tabName);
      } catch (err: any) {
        setIsSyncing(false);
        showToast(`Lỗi tạo bảng tính: ${err.message}`, 'error');
        return false;
      }
    }

    setIsSyncing(true);
    try {
      if (!targetSheetId) throw new Error('Không xác định được ID bảng tính');

      const timestamp = new Date().toLocaleString('vi-VN', {
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

      const summaryList = [];
      if (codesToSave.serialNumber) summaryList.push(`S/N: ${codesToSave.serialNumber}`);
      if (codesToSave.macLan) summaryList.push(`LAN: ${codesToSave.macLan}`);
      if (codesToSave.macWifi) summaryList.push(`WiFi: ${codesToSave.macWifi}`);
      if (codesToSave.qrCode) summaryList.push(`QR: ${codesToSave.qrCode}`);

      const payload = {
        timestamp,
        serialNumber: codesToSave.serialNumber || '',
        macLan: codesToSave.macLan || '',
        macWifi: codesToSave.macWifi || '',
        qrContent: codesToSave.qrCode || '',
      };

      try {
        await appendScannedRecord(targetSheetId, targetTab, payload);
      } catch (appendErr: any) {
        // NẾU KHÔNG THẤY FILE CŨ (404, not found, deleted, permission) -> TỰ TẠO FILE MỚI NGAY LẬP TỨC!
        const errMsg = (appendErr.message || '').toLowerCase();
        const shouldRecreate =
          errMsg.includes('404') ||
          errMsg.includes('not found') ||
          errMsg.includes('không tìm thấy') ||
          errMsg.includes('deleted') ||
          errMsg.includes('unable to parse') ||
          errMsg.includes('permission') ||
          errMsg.includes('403');

        if (shouldRecreate) {
          showToast('⚠️ Không thấy file cũ. Đang tự tạo file Google Sheet mới...', 'info');
          const newSheet = await createNewSpreadsheet('Sổ Quét QR & Barcode Thiết Bị');
          targetSheetId = newSheet.id;
          targetTab = newSheet.tabName;
          saveActiveSpreadsheet(newSheet.id, newSheet.title, newSheet.tabName);
          // Ghi lại vào file mới vừa tạo
          await appendScannedRecord(newSheet.id, newSheet.tabName, payload);
          showToast(`✨ Đã tự động tạo file mới và ghi thành công: ${newSheet.title}`, 'success');
        } else {
          throw appendErr;
        }
      }

      // Thêm vào danh sách lịch sử gần đây
      const recordItem: ScannedRecord = {
        id: `rec-${Date.now()}`,
        timestamp,
        codeType: codesToSave.qrCode ? 'QR_CODE' : 'AI_LABEL',
        serialNumber: codesToSave.serialNumber,
        macLan: codesToSave.macLan,
        macWifi: codesToSave.macWifi,
        qrCode: codesToSave.qrCode,
        assetTag: codesToSave.qrCode,
        company: codesToSave.company,
        licenseKey: codesToSave.licenseKey,
        partNumber: codesToSave.partNumber || '',
        model: codesToSave.model || '',
        salesModelName: '',
        mainBarcode: codesToSave.serialNumber || codesToSave.qrCode || codesToSave.macLan,
        detectedBarcodesCount: 4,
        barcodesSummary: summaryList.join(' | ') || 'Quét mã',
        notes: codesToSave.notes || '',
        syncedToSheets: true,
      };

      setRecentRecords((prev) => [recordItem, ...prev]);

      await reloadLiveSheetRows();
      if (soundEnabled) playSuccessBeep();
      triggerSyncConfetti();

      const mainCode = codesToSave.qrCode || codesToSave.macLan || codesToSave.macWifi || 'Mã mới';
      showToast(`✓ Đã ghi vào Google Sheet: ${mainCode}`, 'success');
      return true;
    } catch (err: any) {
      console.error('Lỗi ghi Google Sheet:', err);
      showToast(`Lỗi ghi Sheet: ${err.message}`, 'error');
      return false;
    } finally {
      setIsSyncing(false);
    }
  };

  // Xử lý khi camera hoặc AI quét thành công
  const handleScanComplete = useCallback(
    async (newRecord: ScannedRecord) => {
      if (isSyncing) return;

      // 1. Lấy giá trị mã mới đọc được
      let incomingMl = (newRecord.macLan || '').trim();
      let incomingMw = (newRecord.macWifi || '').trim();
      let incomingQr = (newRecord.qrCode || '').trim();
      const incomingPn = (newRecord.partNumber || '').trim();

      // Fallback an toàn: Nếu cả 3 mã đều rỗng nhưng có mainBarcode
      if (!incomingMl && !incomingMw && !incomingQr && newRecord.mainBarcode?.trim()) {
        const mb = newRecord.mainBarcode.trim();
        const cleanHex = mb.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
        if (newRecord.codeType === 'QR_CODE') {
          incomingQr = mb;
        } else if (cleanHex.length === 12 && /^[0-9A-F]{12}$/.test(cleanHex)) {
          if (!deviceCodes.macLan) {
            incomingMl = cleanHex;
          } else {
            incomingMw = cleanHex;
          }
        }
      }

      // Xử lý thông minh khi quét MAC: nếu đã có MAC LAN và gặp MAC thứ 2 -> gán vào MAC WiFi!
      if (incomingMl && deviceCodes.macLan && deviceCodes.macLan !== incomingMl && !deviceCodes.macWifi) {
        incomingMw = incomingMl;
        incomingMl = '';
      }

      // Cập nhật bộ 3 mã của thiết bị hiện tại: MAC LAN + MAC WiFi + QRcode (đã bỏ Số seri)
      // Quy tắc: giữ lại mã đã quét trước đó (không xóa đè), chỉ bổ sung mã mới
      const updated: DeviceCodes = {
        serialNumber: '',
        macLan: incomingMl || deviceCodes.macLan,
        macWifi: incomingMw || deviceCodes.macWifi,
        qrCode: incomingQr || deviceCodes.qrCode,
        partNumber: incomingPn || newRecord.partNumber || deviceCodes.partNumber,
        model: newRecord.model || deviceCodes.model,
        company: newRecord.company || deviceCodes.company,
        licenseKey: newRecord.licenseKey || deviceCodes.licenseKey,
        notes: newRecord.notes || deviceCodes.notes,
      };

      // Kiểm tra có ít nhất 1 mã có giá trị không
      const hasAnyCode = Boolean(
        updated.macLan?.trim() ||
        updated.macWifi?.trim() ||
        updated.qrCode?.trim()
      );

      if (!hasAnyCode) {
        // Hoàn toàn không có mã nào đọc được -> không làm gì và không báo lỗi
        return;
      }

      setDeviceCodes(updated);

      const label = incomingQr
        ? `Mã QR [${incomingQr}]`
        : incomingMl
        ? `MAC LAN [${incomingMl}]`
        : incomingMw
        ? `MAC WiFi [${incomingMw}]`
        : 'mã mới';

      // Nếu là ảnh chụp AI (AI Scan đọc cùng lúc tất cả mã trên tem):
      if (newRecord.codeType === 'AI_LABEL') {
        cancelAutoSave();
        if (autoSyncToSheet) {
          const saved = await saveCodesToGoogleSheet(updated, true);
          if (saved) {
            setDeviceCodes(emptyCodes);
          }
        } else {
          showToast(`✓ Đã nhận ${label}. Bấm "Ghi Sheet" để lưu!`, 'info');
        }
        return;
      }

      // Nếu là quét trực tiếp từ camera (Live scan từng mã MAC LAN, MAC WiFi, QR Code):
      if (autoSyncToSheet) {
        // Hủy bỏ bộ hẹn giờ cũ nếu đang chạy
        cancelAutoSave();

        // Khởi động đếm ngược 3 giây cho phép người dùng lia camera quét tiếp các mã còn lại của thiết bị
        setAutoSaveCountdown(3);

        countdownIntervalRef.current = setInterval(() => {
          setAutoSaveCountdown((prev) => {
            if (prev === null || prev <= 1) {
              if (countdownIntervalRef.current) {
                clearInterval(countdownIntervalRef.current);
                countdownIntervalRef.current = null;
              }
              return null;
            }
            return prev - 1;
          });
        }, 1000);

        autoSaveTimerRef.current = setTimeout(async () => {
          cancelAutoSave();
          const toSave = latestDeviceCodesRef.current;
          const hasAny = Boolean(
            toSave.macLan?.trim() ||
            toSave.macWifi?.trim() ||
            toSave.qrCode?.trim()
          );
          if (hasAny) {
            const saved = await saveCodesToGoogleSheet(toSave, true);
            if (saved) {
              setDeviceCodes(emptyCodes);
            }
          }
        }, 3200);
      } else {
        showToast(`✓ Đã nhận ${label}. Bấm "Ghi Sheet" để lưu!`, 'info');
      }
    },
    [deviceCodes, autoSyncToSheet, saveCodesToGoogleSheet, isSyncing, cancelAutoSave]
  );

  // Người dùng bấm lưu thủ công bộ mã
  const handleManualSave = async () => {
    cancelAutoSave();
    const currentCodes = latestDeviceCodesRef.current || deviceCodes;
    const isAllEmpty =
      !currentCodes.macLan?.trim() &&
      !currentCodes.macWifi?.trim() &&
      !currentCodes.qrCode?.trim();

    if (isAllEmpty) {
      if (soundEnabled) playErrorBeep();
      showToast('⚠️ Vui lòng quét hoặc nhập ít nhất một mã trước khi ghi!', 'error');
      return;
    }

    const saved = await saveCodesToGoogleSheet(currentCodes, false);
    if (saved) {
      setDeviceCodes(emptyCodes);
    }
  };

  // Tạo Google Sheet mới thủ công
  const handleCreateNewSheet = async () => {
    try {
      setIsSyncing(true);
      const newSheet = await createNewSpreadsheet('Sổ Quét QR & Barcode Thiết Bị');
      saveActiveSpreadsheet(newSheet.id, newSheet.title, newSheet.tabName);
      await reloadLiveSheetRows();
      showToast(`✨ Đã tạo file Google Sheet mới: ${newSheet.title}`, 'success');
    } catch (err: any) {
      showToast(err.message || 'Không thể tạo bảng tính', 'error');
    } finally {
      setIsSyncing(false);
    }
  };

  // Cập nhật cấu trúc tiêu đề cột theo chuẩn mới (Bỏ Serial Number và cột G đến L, giữ đúng 5 cột A - E)
  const handleUpdateHeaders = async () => {
    if (!spreadsheetId) {
      showToast('⚠️ Vui lòng kết nối Google Sheet trước', 'info');
      return;
    }
    try {
      setIsSyncing(true);
      await updateSpreadsheetHeaders(spreadsheetId, sheetTabName);
      await reloadLiveSheetRows();
      showToast('✨ Đã cập nhật bảng tính: Đã bỏ cột Seri, chỉ giữ đúng 5 cột A - E!', 'success');
    } catch (err: any) {
      showToast(err.message || 'Lỗi cập nhật tiêu đề', 'error');
    } finally {
      setIsSyncing(false);
    }
  };

  // Ghi thử 1 dòng test vào Google Sheet để kiểm tra ngay lập tức
  const handleTestWrite = async () => {
    const testCodes: DeviceCodes = {
      serialNumber: '',
      macLan: '48210B7CB84B',
      macWifi: '381868940999',
      qrCode: `POUYUEN-VN, 3300021371`,
    };
    await saveCodesToGoogleSheet(testCodes);
  };

  // Xuất file CSV (Đã bỏ cột Seri, giữ đúng 5 cột A - E)
  const exportCSV = () => {
    if (recentRecords.length === 0) return;
    const headers = [
      'Thời gian',
      'MAC LAN',
      'MAC WiFi',
      'Mã QR Code 1',
      'Mã QR Code 2',
    ];
    const rows = recentRecords.map((r) => {
      const rawQr = (r.qrCode || '').trim();
      const qrParts = rawQr
        ? rawQr.split(',').map((s) => s.trim())
        : [];
      const qr1 = qrParts[0] || (rawQr ? rawQr : '');
      const qr2 = qrParts[1] || '';
      return [
        `"${r.timestamp}"`,
        `"${r.macLan || ''}"`,
        `"${r.macWifi || ''}"`,
        `"${qr1.replace(/"/g, '""')}"`,
        `"${qr2.replace(/"/g, '""')}"`,
      ];
    });
    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `scanned_codes_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const codeFilledCount = [
    Boolean(deviceCodes.macLan),
    Boolean(deviceCodes.macWifi),
    Boolean(deviceCodes.qrCode),
  ].filter(Boolean).length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans antialiased selection:bg-emerald-500 selection:text-white">
      {/* Toast thông báo */}
      {toast && (
        <div className="fixed top-3 inset-x-3 sm:inset-x-auto sm:right-3 sm:max-w-md z-50 animate-in fade-in slide-in-from-top-2 duration-200">
          <div
            className={`p-3 rounded-2xl shadow-2xl border text-xs font-medium flex items-center justify-between gap-2.5 backdrop-blur-md ${
              toast.type === 'success'
                ? 'bg-emerald-950/95 border-emerald-500/60 text-emerald-200 shadow-emerald-950/50'
                : toast.type === 'error'
                ? 'bg-rose-950/95 border-rose-500/60 text-rose-200 shadow-rose-950/50'
                : 'bg-blue-950/95 border-blue-500/60 text-blue-200 shadow-blue-950/50'
            }`}
          >
            <div className="flex items-center gap-2">
              {toast.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              )}
              <span className="leading-snug">{toast.message}</span>
            </div>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="opacity-70 hover:opacity-100 text-xs px-1 cursor-pointer"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Modal hướng dẫn khắc phục lỗi tên miền Firebase Auth (auth/unauthorized-domain) */}
      {unauthorizedDomain && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-slate-900 border border-amber-500/50 rounded-2xl max-w-lg w-full p-4 sm:p-5 shadow-2xl shadow-amber-950/40 text-slate-200 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center justify-center shrink-0">
                  <AlertCircle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-sm text-white leading-tight">
                    Cấp phép tên miền trên Firebase
                  </h3>
                  <p className="text-[11px] text-amber-400/90 font-mono">
                    auth/unauthorized-domain
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setUnauthorizedDomain(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              Firebase chỉ cho phép Đăng nhập Google từ các tên miền nằm trong danh sách an toàn. Khi bạn publish lên Netlify, tên miền mới cần được thêm vào Firebase:
            </p>

            {/* Hộp thông tin tên miền cần copy */}
            <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[11px] text-slate-400">Tên miền cần cấp phép:</span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(unauthorizedDomain);
                    setCopiedDomain(true);
                    setTimeout(() => setCopiedDomain(false), 2000);
                  }}
                  className="px-2 py-0.5 rounded-lg bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-300 border border-emerald-500/40 text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-colors"
                >
                  {copiedDomain ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedDomain ? 'Đã sao chép' : 'Sao chép'}</span>
                </button>
              </div>
              <div className="p-2 rounded-lg bg-slate-900 border border-slate-800 font-mono text-xs text-amber-300 select-all break-all font-semibold">
                {unauthorizedDomain}
              </div>
              <div className="text-[10px] text-slate-500">
                Project ID: <span className="font-mono text-slate-400">{firebaseConfig.projectId}</span>
              </div>
            </div>

            {/* Các bước thực hiện */}
            <div className="space-y-1.5 text-xs text-slate-300 bg-slate-950/60 border border-slate-800/80 rounded-xl p-3">
              <p className="font-bold text-white text-[11px] uppercase tracking-wide">3 Bước đơn giản để sửa:</p>
              <ol className="list-decimal list-inside space-y-1 text-[11px] text-slate-300 leading-relaxed">
                <li>
                  Mở{' '}
                  <a
                    href={`https://console.firebase.google.com/project/${firebaseConfig.projectId}/authentication/settings`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-emerald-400 underline font-semibold hover:text-emerald-300 inline-flex items-center gap-0.5"
                  >
                    <span>Cài đặt Firebase Auth</span>
                    <ExternalLink className="w-3 h-3 inline" />
                  </a>
                </li>
                <li>
                  Kéo xuống mục <strong className="text-white">Authorized domains</strong> (Miền được ủy quyền) &gt; bấm nút <strong className="text-emerald-400">Add domain</strong> (Thêm miền).
                </li>
                <li>
                  Dán <code className="bg-slate-900 px-1 py-0.5 rounded text-amber-300 font-mono">{unauthorizedDomain}</code> và bấm <strong className="text-white">Save</strong>.
                </li>
              </ol>
            </div>

            {/* Nút hành động */}
            <div className="flex flex-col sm:flex-row items-center gap-2 pt-1">
              <a
                href={`https://console.firebase.google.com/project/${firebaseConfig.projectId}/authentication/settings`}
                target="_blank"
                rel="noreferrer"
                className="w-full sm:flex-1 py-2 px-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 shadow-md active:scale-95 transition-all cursor-pointer text-center"
              >
                <span>Mở Firebase Console</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <button
                type="button"
                onClick={() => {
                  setUnauthorizedDomain(null);
                  handleGoogleSignIn();
                }}
                disabled={isLoggingIn}
                className="w-full sm:flex-1 py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-1.5 shadow-md active:scale-95 transition-all cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isLoggingIn ? 'animate-spin' : ''}`} />
                <span>{isLoggingIn ? 'Đang kết nối...' : 'Thử đăng nhập lại'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header tối giản */}
      <header className="sticky top-0 z-40 bg-slate-950/90 backdrop-blur-md border-b border-slate-800/80 px-3 sm:px-4 py-2.5">
        <div className="max-w-xl mx-auto flex items-center justify-between gap-2">
          {/* Logo & Tên app */}
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-emerald-600 flex items-center justify-center text-white shadow-md shadow-emerald-600/30">
              <Scan className="w-4 h-4" />
            </div>
            <div>
              <h1 className="font-bold text-sm tracking-tight text-white leading-none">Smart Scanner</h1>
              <p className="text-[10px] text-slate-400 mt-0.5">Quét mã & Ghi Google Sheet</p>
            </div>
          </div>

          {/* Trạng thái kết nối Google Sheet & Đăng nhập */}
          <div className="flex items-center gap-2">
            {user ? (
              <div className="flex items-center gap-1.5">
                {spreadsheetId && (
                  <a
                    href={`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`}
                    target="_blank"
                    rel="noreferrer"
                    title="Mở file Google Sheet trên tab mới"
                    className="px-2.5 py-1 rounded-xl bg-emerald-950/80 text-emerald-300 border border-emerald-500/30 text-xs font-semibold flex items-center gap-1 hover:bg-emerald-900/80 transition-colors"
                  >
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="max-w-[100px] truncate sm:max-w-[150px]">
                      {spreadsheetTitle}
                    </span>
                    <ExternalLink className="w-3 h-3 text-emerald-400 shrink-0" />
                  </a>
                )}

                <button
                  type="button"
                  onClick={handleCreateNewSheet}
                  title="Tạo file Google Sheet mới"
                  className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                </button>

                <button
                  type="button"
                  onClick={() => logout()}
                  title="Đăng xuất tài khoản Google"
                  className="p-1.5 rounded-xl text-slate-400 hover:text-rose-400 transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleGoogleSignIn}
                disabled={isLoggingIn}
                className="px-3 py-1.5 rounded-xl bg-white hover:bg-slate-100 text-slate-900 font-bold text-xs flex items-center gap-1.5 shadow-md active:scale-95 transition-all cursor-pointer"
              >
                <span>Đăng nhập Google</span>
              </button>
            )}

            {/* Bật / Tắt âm báo */}
            <button
              type="button"
              onClick={() => setSoundEnabled(!soundEnabled)}
              title={soundEnabled ? 'Tắt âm báo' : 'Bật âm báo'}
              className="p-1.5 rounded-xl text-slate-400 hover:text-white transition-colors"
            >
              {soundEnabled ? <Volume2 className="w-4 h-4 text-emerald-400" /> : <VolumeX className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </header>

      {/* Thân ứng dụng */}
      <main className="flex-1 max-w-xl w-full mx-auto p-3 sm:p-4 space-y-3.5">
        {/* Banner cảnh báo nếu chưa đăng nhập Google */}
        {!user && (
          <div className="bg-amber-950/70 border border-amber-500/40 rounded-2xl p-3 flex items-center justify-between gap-3 text-xs text-amber-200">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
              <span>Chưa kết nối Google: Dữ liệu chưa thể ghi vào Sheet.</span>
            </div>
            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={isLoggingIn}
              className="px-3 py-1.5 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs shrink-0 shadow active:scale-95 transition-all cursor-pointer"
            >
              {isLoggingIn ? 'Đang kết nối...' : 'Kết nối ngay'}
            </button>
          </div>
        )}

        {/* Khối hiển thị Bộ 3 mã: MAC LAN • MAC WiFi • QRcode */}
        <section className="bg-slate-900/90 border border-slate-800 rounded-2xl p-3 shadow-lg">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-white tracking-wide">
                BỘ 3 MÃ THIẾT BỊ
              </span>
              <span
                className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                  codeFilledCount === 3
                    ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                    : codeFilledCount > 0
                    ? 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                    : 'bg-slate-800 text-slate-500 border-slate-700'
                }`}
              >
                {codeFilledCount === 3 ? '✓ 3/3 Đủ mã' : `${codeFilledCount}/3 mã`}
              </span>
            </div>

            {/* Nút lưu thủ công, đếm lùi & Nút làm mới */}
            <div className="flex items-center gap-1.5">
              {autoSaveCountdown !== null && autoSaveCountdown > 0 && (
                <button
                  type="button"
                  onClick={handleManualSave}
                  title="Bấm để lưu vào Sheet ngay"
                  className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] font-bold flex items-center gap-1 animate-pulse cursor-pointer hover:bg-amber-500/30"
                >
                  <span>⏱️ Tự lưu sau {autoSaveCountdown}s (Lưu ngay)</span>
                </button>
              )}

              {codeFilledCount > 0 && (
                <>
                  <button
                    type="button"
                    onClick={handleManualSave}
                    disabled={isSyncing}
                    className="px-2.5 py-1 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center gap-1 shadow-sm active:scale-95 transition-all cursor-pointer"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>Ghi Sheet</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      cancelAutoSave();
                      setDeviceCodes(emptyCodes);
                    }}
                    title="Xóa trắng để quét máy khác"
                    className="p-1 rounded-xl text-slate-400 hover:text-white"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* 3 ô trực quan: MAC LAN, MAC WiFi, QR code */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 font-mono mb-2.5">
            {/* 1. MAC LAN */}
            <div
              className={`p-2.5 rounded-xl border transition-all ${
                deviceCodes.macLan
                  ? 'bg-emerald-950/40 border-emerald-500/60 shadow-sm'
                  : 'bg-slate-950/40 border-slate-800/80'
              }`}
            >
              <div className="flex items-center justify-between text-[10px] text-slate-400 font-sans font-semibold mb-0.5">
                <span>1. MAC LAN</span>
                {deviceCodes.macLan && <span className="text-emerald-400 font-bold">✓</span>}
              </div>
              <input
                type="text"
                placeholder="Trống"
                value={deviceCodes.macLan}
                onChange={(e) => setDeviceCodes((prev) => ({ ...prev, macLan: e.target.value }))}
                className="w-full bg-transparent text-xs font-bold text-emerald-300 placeholder-slate-600 focus:outline-none focus:text-emerald-200 truncate uppercase"
              />
            </div>

            {/* 2. MAC WiFi */}
            <div
              className={`p-2.5 rounded-xl border transition-all ${
                deviceCodes.macWifi
                  ? 'bg-emerald-950/40 border-emerald-500/60 shadow-sm'
                  : 'bg-slate-950/40 border-slate-800/80'
              }`}
            >
              <div className="flex items-center justify-between text-[10px] text-slate-400 font-sans font-semibold mb-0.5">
                <span>2. MAC WiFi</span>
                {deviceCodes.macWifi && <span className="text-emerald-400 font-bold">✓</span>}
              </div>
              <input
                type="text"
                placeholder="Trống"
                value={deviceCodes.macWifi}
                onChange={(e) => setDeviceCodes((prev) => ({ ...prev, macWifi: e.target.value }))}
                className="w-full bg-transparent text-xs font-bold text-cyan-300 placeholder-slate-600 focus:outline-none focus:text-cyan-200 truncate uppercase"
              />
            </div>

            {/* 3. QR Code */}
            <div
              className={`p-2.5 rounded-xl border transition-all ${
                deviceCodes.qrCode
                  ? 'bg-emerald-950/40 border-emerald-500/60 shadow-sm'
                  : 'bg-slate-950/40 border-slate-800/80'
              }`}
            >
              <div className="flex items-center justify-between text-[10px] text-slate-400 font-sans font-semibold mb-0.5">
                <span>3. Mã QR Code</span>
                {deviceCodes.qrCode && (
                  <div className="flex items-center gap-1.5">
                    {deviceCodes.qrCode.includes(',') && (
                      <span className="text-[9px] text-amber-400 font-mono font-bold bg-amber-500/10 px-1 py-0.2 rounded border border-amber-500/30">
                        Tách {deviceCodes.qrCode.split(',').length} cột
                      </span>
                    )}
                    <span className="text-emerald-400 font-bold">✓</span>
                  </div>
                )}
              </div>
              <input
                type="text"
                placeholder="Trống"
                value={deviceCodes.qrCode}
                onChange={(e) => setDeviceCodes((prev) => ({ ...prev, qrCode: e.target.value }))}
                className="w-full bg-transparent text-xs font-bold text-amber-300 placeholder-slate-600 focus:outline-none focus:text-amber-200 truncate"
              />
            </div>
          </div>

          {/* Thanh cài đặt chế độ tự động ghi & Chặn trùng */}
          <div className="pt-2 border-t border-slate-800/70 flex items-center justify-between text-[11px] text-slate-300">
            {/* Tự động ghi ngay */}
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoSyncToSheet}
                onChange={(e) => setAutoSyncToSheet(e.target.checked)}
                className="w-3.5 h-3.5 rounded text-emerald-600 focus:ring-0 bg-slate-950 border-slate-700 cursor-pointer"
              />
              <span className="flex items-center gap-1 font-medium">
                <Zap className="w-3 h-3 text-amber-400" /> Tự động ghi ngay khi quét
              </span>
            </label>

            {/* Chặn trùng */}
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={preventDuplicate}
                onChange={(e) => setPreventDuplicate(e.target.checked)}
                className="w-3.5 h-3.5 rounded text-emerald-600 focus:ring-0 bg-slate-950 border-slate-700 cursor-pointer"
              />
              <span className="flex items-center gap-1 font-medium">
                <ShieldCheck className="w-3 h-3 text-emerald-400" /> Chặn ghi trùng
              </span>
            </label>
          </div>
        </section>

        {/* 2 Tab đơn giản: Camera Quét vs Bảng Tính */}
        <div className="flex items-center bg-slate-900 p-1 rounded-2xl border border-slate-800 text-xs font-bold">
          <button
            type="button"
            onClick={() => setActiveTab('scan')}
            className={`flex-1 py-2 rounded-xl flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
              activeTab === 'scan' ? 'bg-emerald-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Scan className="w-3.5 h-3.5" />
            <span>Camera Quét</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('sheet');
              reloadLiveSheetRows();
            }}
            className={`flex-1 py-2 rounded-xl flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
              activeTab === 'sheet' ? 'bg-blue-600 text-white shadow-md' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            <span>Google Sheet ({liveSheetRows.length > 1 ? liveSheetRows.length - 1 : 0})</span>
          </button>
        </div>

        {/* Tab 1: Camera Quét & Lịch sử phiên */}
        {activeTab === 'scan' && (
          <div className="space-y-3.5">
            <CameraScanner
              onScanComplete={handleScanComplete}
              soundEnabled={soundEnabled}
              isSyncing={isSyncing}
            />

            {/* Bảng các mã đã quét gần đây */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3 shadow-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Lịch sử quét ({recentRecords.length})
                </span>

                <div className="flex items-center gap-2 text-xs">
                  {recentRecords.length > 0 && (
                    <button
                      type="button"
                      onClick={exportCSV}
                      className="text-slate-400 hover:text-slate-200 flex items-center gap-1 text-[11px] cursor-pointer"
                    >
                      <Download className="w-3 h-3" /> Xuất CSV
                    </button>
                  )}
                  {spreadsheetId && (
                    <a
                      href={`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-emerald-400 hover:text-emerald-300 font-medium flex items-center gap-1 text-[11px]"
                    >
                      <span>Mở Sheet</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              </div>

              {recentRecords.length === 0 ? (
                <div className="py-6 text-center text-slate-500 text-xs">
                  Chưa có mã nào được quét. Đưa camera vào mã QR hoặc tem nhãn để bắt đầu.
                </div>
              ) : (
                <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                  {recentRecords.slice(0, 8).map((r) => (
                    <div
                      key={r.id}
                      className="p-2 rounded-xl bg-slate-950/70 border border-slate-800/80 flex items-center justify-between gap-2 text-xs font-mono"
                    >
                      <div className="space-y-0.5 truncate flex-1">
                        <div className="flex items-center gap-2 truncate">
                          <span className="font-bold text-white select-all">
                            {r.serialNumber || r.qrCode || r.macLan || 'Thiết bị'}
                          </span>
                          <span
                            className={`text-[9px] font-bold px-1.5 py-0.2 rounded border font-sans ${
                              r.syncedToSheets
                                ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                                : 'bg-amber-500/20 text-amber-400 border-amber-500/40'
                            }`}
                          >
                            {r.syncedToSheets ? '✓ Đã ghi Sheet' : 'Chờ'}
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-400 truncate flex gap-2 font-sans">
                          {r.macLan && <span>LAN: {r.macLan}</span>}
                          {r.macWifi && <span>WiFi: {r.macWifi}</span>}
                          {r.qrCode && <span>QR: {r.qrCode}</span>}
                        </div>
                      </div>
                      <span className="text-[10px] text-slate-500 shrink-0 font-sans">{r.timestamp.split(' ')[0]}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab 2: Xem trực tiếp bảng Google Sheet */}
        {activeTab === 'sheet' && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-3 sm:p-4 shadow-lg space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800 pb-2.5 gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <FileSpreadsheet className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="font-bold text-xs text-white truncate max-w-[160px] sm:max-w-[220px]">
                  {spreadsheetTitle}
                </span>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {/* Nút test ghi 1 dòng */}
                <button
                  type="button"
                  onClick={handleTestWrite}
                  disabled={isSyncing}
                  title="Ghi thử 1 dòng mẫu để kiểm tra kết nối ngay"
                  className="px-2 py-1 rounded-lg bg-emerald-700/80 hover:bg-emerald-600 text-white text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <Sparkles className="w-3 h-3 text-amber-300" />
                  <span className="hidden sm:inline">Ghi test</span>
                </button>

                {/* Nút cập nhật cột */}
                <button
                  type="button"
                  onClick={handleUpdateHeaders}
                  disabled={isSyncing}
                  title="Cập nhật tiêu đề bảng tính: Bỏ cột Seri, chỉ giữ đúng 5 cột A - E (Thời gian, MAC LAN, MAC WiFi, QR 1, QR 2)"
                  className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer border border-amber-500/30"
                >
                  <Sparkles className="w-3 h-3 text-amber-400" />
                  <span className="hidden sm:inline">Cập nhật 5 cột</span>
                </button>

                {/* Làm mới dữ liệu */}
                <button
                  type="button"
                  onClick={reloadLiveSheetRows}
                  disabled={isLoadingRows}
                  title="Làm mới dữ liệu từ Google Sheet"
                  className="p-1.5 rounded-lg text-slate-400 hover:text-white transition-colors cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoadingRows ? 'animate-spin' : ''}`} />
                </button>

                {/* Tạo Sheet mới */}
                <button
                  type="button"
                  onClick={handleCreateNewSheet}
                  disabled={isSyncing}
                  title="Tạo file Google Sheet mới ngay"
                  className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span className="hidden sm:inline">Tạo file mới</span>
                </button>

                {/* Mở Google Sheets */}
                {spreadsheetId && (
                  <a
                    href={`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`}
                    target="_blank"
                    rel="noreferrer"
                    className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center gap-1"
                  >
                    <span>Mở Sheet</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
            </div>

            {isLoadingRows && liveSheetRows.length === 0 ? (
              <div className="py-12 text-center text-slate-500 text-xs flex flex-col items-center gap-2">
                <RefreshCw className="w-5 h-5 animate-spin text-emerald-400" />
                <span>Đang tải dữ liệu từ Google Sheets...</span>
              </div>
            ) : liveSheetRows.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950 max-h-96">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-slate-900 border-b border-slate-800 text-slate-400 font-semibold text-[11px]">
                      <th className="p-2.5 text-center w-10">#</th>
                      {liveSheetRows[0].slice(0, 5).map((h, idx) => (
                        <th key={idx} className="p-2.5 whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                    {liveSheetRows.slice(1).map((row, rIdx) => (
                      <tr key={rIdx} className="hover:bg-slate-900/50 text-slate-300">
                        <td className="p-2.5 text-center text-slate-600 font-sans">{rIdx + 1}</td>
                        {row.slice(0, 5).map((cell, cIdx) => (
                          <td
                            key={cIdx}
                            className={`p-2.5 max-w-[160px] truncate ${
                              cIdx === 1 || cIdx === 2
                                ? 'text-emerald-300 font-bold'
                                : cIdx >= 3
                                ? 'text-amber-300 font-medium'
                                : ''
                            }`}
                          >
                            {cell || '—'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="py-12 text-center text-slate-500 text-xs">
                Bảng tính đang trống. Hãy quét các mã để tự động ghi vào đây.
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
