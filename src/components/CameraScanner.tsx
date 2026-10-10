import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Camera,
  CameraOff,
  SwitchCamera,
  Sparkles,
  Zap,
  ZapOff,
  Upload,
  RefreshCw,
  QrCode,
  Scan,
} from 'lucide-react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';
import { ExtractedLabelData, ScannedRecord } from '../types';
import { playSuccessBeep, playErrorBeep, triggerSyncConfetti } from '../utils/feedback';

interface CameraScannerProps {
  onScanComplete: (record: ScannedRecord) => void;
  soundEnabled: boolean;
  isSyncing: boolean;
}

export const CameraScanner: React.FC<CameraScannerProps> = ({
  onScanComplete,
  soundEnabled,
  isSyncing,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const zxingReaderRef = useRef<BrowserMultiFormatReader | null>(null);
  const zxingControlsRef = useRef<any>(null);
  const nativeBarcodeDetectorRef = useRef<any>(null);
  const nativeScanTimerRef = useRef<any>(null);

  const [cameraActive, setCameraActive] = useState<boolean>(true);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [torchOn, setTorchOn] = useState<boolean>(false);
  const [torchSupported, setTorchSupported] = useState<boolean>(false);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const isCooldownRef = useRef<boolean>(false);
  const lastScannedRef = useRef<{ text: string; time: number } | null>(null);
  const [lastScannedText, setLastScannedText] = useState<string | null>(null);

  // Phân loại thông minh danh sách mã quét được thành Bộ 4 mã: Seri, MAC LAN, MAC WiFi, QR Code
  const processDetectedItems = useCallback(
    (items: Array<{ text: string; format?: string }>) => {
      const validItems = items
        .map((i) => ({ text: (i.text || '').trim(), format: i.format || '' }))
        .filter((i) => i.text.length > 0);
      if (validItems.length === 0) return;

      const now = Date.now();
      if (isCooldownRef.current) return;

      // Chặn quét lặp lại liên tục với cùng danh sách mã trong 2.5 giây
      const combinedKey = validItems
        .map((i) => i.text)
        .sort()
        .join('::');
      if (
        lastScannedRef.current &&
        lastScannedRef.current.text === combinedKey &&
        now - lastScannedRef.current.time < 2500
      ) {
        return;
      }

      isCooldownRef.current = true;
      lastScannedRef.current = { text: combinedKey, time: now };
      setTimeout(() => {
        isCooldownRef.current = false;
      }, 1500);

      let qrCode = '';
      let serialNumber = '';
      let macLan = '';
      let macWifi = '';
      let partNumber = '';
      let company = '';
      let licenseKey = '';
      const candidateMacs: string[] = [];

      for (const item of validItems) {
        const raw = item.text;
        const fmt = (item.format || '').toUpperCase();
        const isQr =
          fmt.includes('QR') ||
          fmt.includes('MATRIX') ||
          fmt.includes('AZTEC') ||
          fmt === 'QR_CODE' ||
          fmt === 'DATA_MATRIX';

        if (isQr) {
          if (!qrCode) qrCode = raw;
          if (raw.toLowerCase().includes('pouyuen')) {
            company = 'POUYUEN VIETNAM COMPANY';
          }
          const keyMatch = raw.match(/[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}/);
          if (keyMatch) licenseKey = keyMatch[0];
          continue;
        }

        // 1D Barcode: S/N, MAC LAN, MAC WiFi, P/N
        const cleanHex = raw.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
        const rawUpper = raw.toUpperCase();
        const isMacFormat = cleanHex.length === 12 && /^[0-9A-F]{12}$/.test(cleanHex);
        const hasMacKeyword =
          rawUpper.includes('MAC') ||
          rawUpper.includes('LAN') ||
          rawUpper.includes('ETH') ||
          rawUpper.includes('WIFI') ||
          rawUpper.includes('WLAN');

        // 1. MAC WiFi chỉ định
        if ((rawUpper.includes('WIFI') || rawUpper.includes('WLAN')) && isMacFormat) {
          macWifi = cleanHex;
          continue;
        }

        // 2. MAC LAN / Ethernet chỉ định
        if ((rawUpper.includes('LAN') || rawUpper.includes('ETH')) && isMacFormat) {
          macLan = cleanHex;
          continue;
        }

        // 3. Chuỗi chuẩn 12 ký tự hex (chuẩn MAC trên tem máy tính) hoặc có chữ MAC
        if (isMacFormat && !rawUpper.includes('SN') && !rawUpper.includes('SERI') && !rawUpper.includes('SERIAL')) {
          candidateMacs.push(cleanHex);
          continue;
        }

        // 4. Tiền tố S/N hoặc Seri
        if (/^(SN|S\/N|SERI|SERIAL|SERVICE\s*TAG)[\s:-]*/i.test(raw)) {
          serialNumber = raw.replace(/^(SN|S\/N|SERI|SERIAL|SERVICE\s*TAG)[\s:-]*/i, '').trim() || raw;
          continue;
        }

        // 5. Tiền tố P/N
        if (/^(PN|P\/N|PART)[\s:-]*/i.test(raw)) {
          partNumber = raw.replace(/^(PN|P\/N|PART)[\s:-]*/i, '').trim() || raw;
          if (!serialNumber) serialNumber = raw;
          continue;
        }

        // 6. Bất kỳ mã vạch 1D nào khác có dạng MAC hoặc Hex -> Ưu tiên MAC
        if (!macLan && isMacFormat) {
          macLan = cleanHex;
        } else if (!macWifi && isMacFormat) {
          macWifi = cleanHex;
        }
      }

      // Phân bổ danh sách các MAC 12-hex vào MAC LAN và MAC WiFi
      for (const mac of candidateMacs) {
        if (!macLan) {
          macLan = mac;
        } else if (macLan !== mac && !macWifi) {
          macWifi = mac;
        }
      }

      // Đảm bảo không bị rỗng nếu có mã
      if (!qrCode && !macLan && !macWifi && validItems.length > 0) {
        const itemText = validItems[0].text;
        const hex = itemText.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
        if (hex.length === 12) {
          macLan = hex;
        }
      }

      // Hiển thị thông báo nhận diện (MAC LAN, MAC WiFi, QR Code)
      const summaryParts: string[] = [];
      if (macLan) summaryParts.push(`MAC LAN: ${macLan}`);
      if (macWifi) summaryParts.push(`MAC WiFi: ${macWifi}`);
      if (qrCode) summaryParts.push(`QR: ${qrCode.slice(0, 16)}`);

      const summaryText = summaryParts.join(' | ') || validItems[0].text;
      setLastScannedText(summaryText);
      setTimeout(() => setLastScannedText(null), 2500);

      if (soundEnabled) playSuccessBeep();

      const record: ScannedRecord = {
        id: `scan-${Date.now()}`,
        timestamp: new Date().toLocaleString('vi-VN', {
          hour12: false,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        codeType: qrCode && !macLan && !macWifi ? 'QR_CODE' : 'BARCODE',
        qrCode,
        assetTag: qrCode,
        company,
        licenseKey,
        serialNumber: '',
        partNumber,
        macLan,
        macWifi,
        model: qrCode ? 'Mã QR' : 'Mã Barcode',
        salesModelName: '',
        mainBarcode: macLan || macWifi || qrCode,
        detectedBarcodesCount: validItems.length,
        barcodesSummary: summaryText,
        notes: `Quét trực tiếp (${validItems.length} mã)`,
        syncedToSheets: false,
      };

      triggerSyncConfetti();
      onScanComplete(record);
    },
    [soundEnabled, onScanComplete]
  );

  // Live Barcode & QR Code continuous reader (Hỗ trợ BarcodeDetector Native + ZXing với hints TRY_HARDER)
  const startLiveScanning = useCallback(() => {
    if (!videoRef.current) return;

    // 1. Khởi tạo native BarcodeDetector nếu trình duyệt hỗ trợ (Chrome Android/Desktop, Edge)
    if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
      try {
        if (!nativeBarcodeDetectorRef.current) {
          nativeBarcodeDetectorRef.current = new (window as any).BarcodeDetector({
            formats: [
              'code_128',
              'code_39',
              'code_93',
              'ean_13',
              'ean_8',
              'itf',
              'qr_code',
              'data_matrix',
              'aztec',
              'upc_a',
              'upc_e',
              'codabar',
            ],
          });
        }
      } catch (detErr) {
        console.warn('Native BarcodeDetector init error:', detErr);
        nativeBarcodeDetectorRef.current = null;
      }
    }

    // 2. Chạy vòng lặp quét qua Native BarcodeDetector (siêu nhanh, nhận đồng thời nhiều mã vạch trong 1 khung hình)
    if (nativeBarcodeDetectorRef.current) {
      if (nativeScanTimerRef.current) {
        clearInterval(nativeScanTimerRef.current);
      }

      nativeScanTimerRef.current = setInterval(async () => {
        const video = videoRef.current;
        if (!video || video.readyState < 2 || isCooldownRef.current) return;

        try {
          const detected = await nativeBarcodeDetectorRef.current.detect(video);
          if (detected && detected.length > 0) {
            const items = detected.map((d: any) => ({
              text: d.rawValue || '',
              format: d.format || 'BARCODE',
            }));
            processDetectedItems(items);
          }
        } catch (scanErr) {
          // Bỏ qua lỗi khung hình
        }
      }, 150);
    }

    // 3. ZXing Reader với TRY_HARDER và toàn bộ định dạng 1D Barcode (Code 128, Code 39, EAN, ITF...)
    try {
      if (!zxingReaderRef.current) {
        const hints = new Map();
        hints.set(DecodeHintType.TRY_HARDER, true);
        hints.set(DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.CODE_128,
          BarcodeFormat.CODE_39,
          BarcodeFormat.CODE_93,
          BarcodeFormat.EAN_13,
          BarcodeFormat.EAN_8,
          BarcodeFormat.ITF,
          BarcodeFormat.UPC_A,
          BarcodeFormat.UPC_E,
          BarcodeFormat.CODABAR,
          BarcodeFormat.QR_CODE,
          BarcodeFormat.DATA_MATRIX,
          BarcodeFormat.AZTEC,
        ]);
        zxingReaderRef.current = new BrowserMultiFormatReader(hints, {
          delayBetweenScanAttempts: 150,
          delayBetweenScanSuccess: 300,
        });
      }

      // Bắt đầu quét với ZXing
      zxingReaderRef.current
        .decodeFromVideoElement(videoRef.current, (result) => {
          if (result && !isCooldownRef.current) {
            const rawText = result.getText()?.trim() || '';
            if (!rawText) return;

            const formatEnum = result.getBarcodeFormat();
            const formatName = (BarcodeFormat as any)[formatEnum] || String(formatEnum);

            processDetectedItems([{ text: rawText, format: formatName }]);
          }
        })
        .then((controls) => {
          zxingControlsRef.current = controls;
        })
        .catch((e) => {
          console.warn('ZXing decodeFromVideoElement exception:', e);
        });
    } catch (e) {
      console.warn('Live scanner initialization error:', e);
    }
  }, [processDetectedItems]);

  // Start camera stream with multi-level graceful fallback (Ưu tiên Full HD 1080p và lấy nét liên tục)
  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError('Trình duyệt hoặc môi trường này không hỗ trợ truy cập Camera trực tiếp.');
      setCameraActive(false);
      return;
    }

    try {
      setCameraError(null);
      if (nativeScanTimerRef.current) {
        clearInterval(nativeScanTimerRef.current);
        nativeScanTimerRef.current = null;
      }
      if (zxingControlsRef.current) {
        try {
          zxingControlsRef.current.stop();
        } catch (e) {}
        zxingControlsRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }

      // Danh sách các cấu hình MediaStream theo thứ tự ưu tiên giảm dần
      // Sử dụng ideal resolution Full HD (1920x1080) và HD (1280x720) không dùng min cứng để tránh lỗi 'Requested device not found' trên điện thoại
      const candidateConstraints: MediaStreamConstraints[] = [
        // 1. Camera mong muốn với độ phân giải Full HD (1920x1080)
        {
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        },
        // 2. Camera tiêu chuẩn HD 720p
        {
          video: {
            facingMode: { ideal: facingMode },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        },
        // 3. Camera mong muốn không ràng buộc độ phân giải
        {
          video: {
            facingMode: { ideal: facingMode },
          },
          audio: false,
        },
        // 4. Đổi chiều camera (hữu ích cho laptop/PC chỉ có webcam trước)
        {
          video: {
            facingMode: facingMode === 'environment' ? 'user' : 'environment',
          },
          audio: false,
        },
        // 5. Mở bất kỳ camera nào có sẵn trên hệ thống
        {
          video: true,
          audio: false,
        },
      ];

      let stream: MediaStream | null = null;
      let lastErr: any = null;

      for (const constraints of candidateConstraints) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          if (stream) break;
        } catch (candidateErr: any) {
          lastErr = candidateErr;
          // Nếu người dùng từ chối cấp quyền, dừng ngay không cần thử các cấu hình khác
          if (candidateErr.name === 'NotAllowedError' || candidateErr.name === 'PermissionDeniedError') {
            throw candidateErr;
          }
        }
      }

      if (!stream) {
        throw lastErr || new Error('Không thể kết nối tới thiết bị Camera.');
      }

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch((playErr) => {
          console.warn('Video play warning:', playErr);
        });
      }

      setCameraActive(true);

      const track = stream.getVideoTracks()[0];
      if (track) {
        try {
          const capabilities = (track.getCapabilities ? track.getCapabilities() : {}) as any;
          setTorchSupported(!!capabilities.torch);
          // Tự động kích hoạt chế độ lấy nét liên tục nếu phần cứng hỗ trợ
          if (track.applyConstraints && capabilities.focusMode && Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
            track.applyConstraints({
              advanced: [{ focusMode: 'continuous' } as any],
            }).catch(() => {});
          }
        } catch (capErr) {
          console.warn('Lỗi kiểm tra tính năng camera track:', capErr);
        }
      }

      startLiveScanning();
    } catch (err: any) {
      console.warn('Camera access error:', err);
      let errorMsg = 'Không thể mở Camera.';
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        errorMsg = 'Vui lòng cấp quyền truy cập Camera trong trình duyệt.';
      } else if (
        err.name === 'NotFoundError' ||
        err.name === 'DevicesNotFoundError' ||
        err.message?.toLowerCase().includes('not found') ||
        err.message?.toLowerCase().includes('requested device')
      ) {
        errorMsg = 'Không tìm thấy thiết bị Camera. Bạn có thể bấm "Tải ảnh" bên dưới để quét từ ảnh tem.';
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        errorMsg = 'Camera đang bị ứng dụng khác chiếm dụng hoặc bị khóa.';
      } else if (err.name === 'OverconstrainedError') {
        errorMsg = 'Camera không đáp ứng được yêu cầu kỹ thuật của trình duyệt.';
      } else {
        errorMsg = `Lỗi Camera: ${err.message || 'Không thể mở thiết bị'}`;
      }
      setCameraError(errorMsg);
      setCameraActive(false);
    }
  }, [facingMode, startLiveScanning]);

  const stopCamera = useCallback(() => {
    if (nativeScanTimerRef.current) {
      clearInterval(nativeScanTimerRef.current);
      nativeScanTimerRef.current = null;
    }
    if (zxingControlsRef.current) {
      try {
        zxingControlsRef.current.stop();
      } catch (e) {}
      zxingControlsRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraActive(false);
    setTorchOn(false);
  }, []);

  const toggleTorch = async () => {
    if (!streamRef.current || !torchSupported) return;
    try {
      const track = streamRef.current.getVideoTracks()[0];
      const newTorch = !torchOn;
      await (track as any).applyConstraints({
        advanced: [{ torch: newTorch }],
      });
      setTorchOn(newTorch);
    } catch (err) {
      console.warn('Torch toggle failed:', err);
    }
  };

  const switchCamera = () => {
    setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'));
  };

  // AI OCR Label & QR Analyzer: Takes frame and sends to Gemini OCR server
  const captureAndAnalyze = async (customImageData?: string) => {
    let base64Image = customImageData;

    if (!base64Image) {
      if (!videoRef.current || !cameraActive) {
        setCameraError('Bật camera để chụp quét.');
        return;
      }

      const video = videoRef.current;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      base64Image = canvas.toDataURL('image/jpeg', 0.92);
    }

    setIsAnalyzing(true);
    setCameraError(null);

    try {
      const response = await fetch('/api/scan-label', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: base64Image,
          mimeType: 'image/jpeg',
        }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Lỗi máy chủ HTTP ${response.status}`);
      }

      const json = await response.json();
      const extracted: ExtractedLabelData = json.data;

      const barcodesList = extracted.detectedBarcodes || [];
      const barcodesSummary = barcodesList
        .map((b) => `${b.field}: ${b.value}`)
        .join(' | ');

      let qrCodeVal = (extracted.qrCode || extracted.assetTag || '').trim();
      let serialVal = (extracted.serialNumber || '').trim();
      let macLanVal = (extracted.macLan || '').trim();
      let macWifiVal = (extracted.macWifi || '').trim();
      let partNumVal = (extracted.partNumber || '').trim();

      // Nếu còn trường nào rỗng, duyệt qua detectedBarcodes để điền tự động
      for (const b of barcodesList) {
        const f = (b.field || '').toUpperCase();
        const v = (b.value || '').trim();
        if (!v) continue;

        if ((f.includes('QR') || f.includes('ASSET') || b.format?.includes('QR')) && !qrCodeVal) {
          qrCodeVal = v;
        } else if ((f.includes('LAN') || (f.includes('MAC') && !f.includes('WIFI'))) && !macLanVal) {
          macLanVal = v.replace(/[:-]/g, '').toUpperCase();
        } else if ((f.includes('WIFI') || f.includes('WLAN')) && !macWifiVal) {
          macWifiVal = v.replace(/[:-]/g, '').toUpperCase();
        } else if ((f.includes('SN') || f.includes('SERI') || f.includes('SERIAL')) && !serialVal) {
          serialVal = v;
        } else if ((f.includes('PN') || f.includes('PART')) && !partNumVal) {
          partNumVal = v;
        }
      }

      // Nếu vẫn rỗng cả 4 trường nhưng có danh sách barcode, lấy phần tử đầu tiên làm Serial / QR
      if (!qrCodeVal && !serialVal && !macLanVal && !macWifiVal && barcodesList.length > 0) {
        const first = barcodesList[0];
        if (first.format?.includes('QR')) {
          qrCodeVal = first.value;
        } else {
          serialVal = first.value;
        }
      }

      const isQrDominant =
        !!qrCodeVal ||
        !!extracted.assetTag ||
        barcodesList.some((b) => b.format?.includes('QR'));

      const record: ScannedRecord = {
        id: `ai-scan-${Date.now()}`,
        timestamp: new Date().toLocaleString('vi-VN', {
          hour12: false,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
        codeType: isQrDominant ? 'QR_CODE' : 'AI_LABEL',
        qrCode: qrCodeVal,
        assetTag: extracted.assetTag || qrCodeVal,
        company: extracted.company || '',
        licenseKey: extracted.licenseKey || '',
        serialNumber: serialVal,
        partNumber: partNumVal,
        macLan: macLanVal,
        macWifi: macWifiVal,
        model: extracted.model || extracted.brand || 'Thiết bị',
        salesModelName: extracted.salesModelName || '',
        mainBarcode:
          serialVal ||
          qrCodeVal ||
          macLanVal ||
          (barcodesList[0]?.value ?? ''),
        detectedBarcodesCount: barcodesList.length,
        barcodesSummary: barcodesSummary || (extracted.notes ?? 'Quét nhãn AI'),
        notes: [
          extracted.company ? `Công ty: ${extracted.company}` : '',
          extracted.licenseKey ? `Key: ${extracted.licenseKey}` : '',
          extracted.brand ? `Hãng: ${extracted.brand}` : '',
          extracted.cnCode ? `CN: ${extracted.cnCode}` : '',
        ]
          .filter(Boolean)
          .join(', '),
        rawImage: base64Image,
        syncedToSheets: false,
      };

      if (soundEnabled) playSuccessBeep();
      triggerSyncConfetti();
      onScanComplete(record);
    } catch (err: any) {
      console.error('Scan error:', err);
      if (soundEnabled) playErrorBeep();
      setCameraError(err.message || 'Không nhận diện được tem. Vui lòng thử lại.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      captureAndAnalyze(result);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  useEffect(() => {
    startCamera();
    return () => {
      stopCamera();
    };
  }, [facingMode]);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl transition-all">
      {/* Top Status Bar: Clean & Minimal */}
      <div className="px-4 py-2.5 bg-slate-950/90 border-b border-slate-800/80 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="font-semibold text-slate-300">
            Camera quét trực tiếp QR & Mã vạch
          </span>
        </div>

        {/* Floating Tool Controls */}
        <div className="flex items-center gap-1.5">
          {torchSupported && cameraActive && (
            <button
              type="button"
              onClick={toggleTorch}
              title={torchOn ? 'Tắt đèn pin' : 'Bật đèn pin'}
              className={`p-1.5 rounded-lg border transition-all ${
                torchOn
                  ? 'bg-amber-500 text-slate-950 border-amber-400 font-bold'
                  : 'bg-slate-800 text-slate-300 border-slate-700 hover:text-white'
              }`}
            >
              {torchOn ? <Zap className="w-3.5 h-3.5 fill-current" /> : <ZapOff className="w-3.5 h-3.5" />}
            </button>
          )}

          {cameraActive && (
            <button
              type="button"
              onClick={switchCamera}
              title="Đổi camera trước/sau"
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-all"
            >
              <SwitchCamera className="w-3.5 h-3.5" />
            </button>
          )}

          <label
            title="Tải ảnh từ thư viện để quét"
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 cursor-pointer transition-all flex items-center gap-1"
          >
            <Upload className="w-3.5 h-3.5" />
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileUpload}
            />
          </label>
        </div>
      </div>

      {/* Main Camera Viewfinder */}
      <div className="relative w-full aspect-[4/3] sm:aspect-[16/10] bg-black overflow-hidden flex items-center justify-center">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className={`w-full h-full object-cover transition-opacity duration-200 ${
            cameraActive ? 'opacity-100' : 'opacity-0 absolute pointer-events-none'
          }`}
        />

        {/* Camera Off Placeholder */}
        {!cameraActive && (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-slate-950">
            <div className="w-12 h-12 rounded-2xl bg-slate-800 flex items-center justify-center text-slate-400 mb-3">
              <CameraOff className="w-6 h-6" />
            </div>
            <p className="text-white font-medium text-xs mb-1">Camera chưa được kích hoạt</p>
            <p className="text-slate-400 text-[11px] max-w-xs mb-3.5">
              Đảm bảo thiết bị có camera hoặc chọn ảnh chụp tem nhãn từ thư viện để AI tự động quét.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={startCamera}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center gap-1.5 shadow-md active:scale-95 transition-all cursor-pointer"
              >
                <Camera className="w-4 h-4" />
                Bật Camera
              </button>
              <label className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs flex items-center gap-1.5 shadow-md active:scale-95 transition-all cursor-pointer border border-slate-700">
                <Upload className="w-4 h-4 text-amber-400" />
                <span>Tải ảnh tem nhãn</span>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={handleFileUpload}
                />
              </label>
            </div>
          </div>
        )}

        {/* Aiming Reticle (Aim at QR or Barcode) */}
        {cameraActive && (
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center p-6">
            <div className="relative w-64 h-64 sm:w-72 sm:h-72 border-2 border-dashed border-emerald-400/60 rounded-3xl bg-emerald-500/5 flex items-center justify-center">
              {/* Corner brackets */}
              <div className="absolute -top-1 -left-1 w-6 h-6 border-t-4 border-l-4 border-emerald-400 rounded-tl-2xl" />
              <div className="absolute -top-1 -right-1 w-6 h-6 border-t-4 border-r-4 border-emerald-400 rounded-tr-2xl" />
              <div className="absolute -bottom-1 -left-1 w-6 h-6 border-b-4 border-l-4 border-emerald-400 rounded-bl-2xl" />
              <div className="absolute -bottom-1 -right-1 w-6 h-6 border-b-4 border-r-4 border-emerald-400 rounded-br-2xl" />

              {/* Red laser line for barcode aiming */}
              <div className="w-48 h-0.5 bg-gradient-to-r from-transparent via-red-500 to-transparent animate-pulse" />
            </div>
          </div>
        )}

        {/* Last scanned toast in camera */}
        {lastScannedText && (
          <div className="absolute bottom-3 inset-x-4 flex justify-center pointer-events-none z-10">
            <div className="bg-slate-950/90 border border-emerald-500/40 text-emerald-300 text-[11px] font-mono px-3 py-1 rounded-full shadow-lg truncate max-w-xs">
              ✓ Đã nhận: {lastScannedText}
            </div>
          </div>
        )}

        {/* AI Analyzing Overlay */}
        {isAnalyzing && (
          <div className="absolute inset-0 bg-slate-950/85 backdrop-blur-sm flex flex-col items-center justify-center z-20">
            <RefreshCw className="w-8 h-8 text-emerald-400 animate-spin mb-2" />
            <p className="text-white text-xs font-semibold">AI đang đọc toàn bộ tem nhãn...</p>
          </div>
        )}
      </div>

      {/* Error Bar */}
      {cameraError && (
        <div className="p-2.5 bg-rose-950/80 border-t border-rose-800 text-rose-300 text-xs flex items-center justify-between">
          <span>{cameraError}</span>
          <button
            type="button"
            onClick={startCamera}
            className="px-2 py-0.5 rounded bg-rose-800 text-white text-[10px]"
          >
            Thử lại
          </button>
        </div>
      )}

      {/* Action Footer: 1 Big Clear Primary Action */}
      <div className="p-3 bg-slate-950 border-t border-slate-800 flex items-center justify-center gap-2">
        {cameraActive ? (
          <button
            type="button"
            onClick={() => captureAndAnalyze()}
            disabled={isAnalyzing || isSyncing}
            className="w-full max-w-sm py-3 px-4 rounded-2xl bg-emerald-600 hover:bg-emerald-500 active:scale-98 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/25 transition-all cursor-pointer disabled:opacity-50"
          >
            <Sparkles className="w-4 h-4 text-emerald-200" />
            <span>{isAnalyzing ? 'Đang phân tích...' : 'Chụp Quét Toàn Bộ Tem (AI)'}</span>
          </button>
        ) : (
          <label className="w-full max-w-sm py-3 px-4 rounded-2xl bg-emerald-600 hover:bg-emerald-500 active:scale-98 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/25 transition-all cursor-pointer">
            <Upload className="w-4 h-4 text-emerald-200" />
            <span>{isAnalyzing ? 'Đang phân tích ảnh...' : 'Tải Ảnh / Chụp Ảnh Quét Tem (AI)'}</span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleFileUpload}
            />
          </label>
        )}
      </div>
    </div>
  );
};
