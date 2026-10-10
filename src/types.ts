export interface DetectedBarcode {
  field: string;
  value: string;
  format?: string;
}

export interface ExtractedLabelData {
  qrCode?: string;
  assetTag?: string;
  company?: string;
  licenseKey?: string;
  brand?: string;
  model?: string;
  salesModelName?: string;
  serialNumber?: string;
  partNumber?: string;
  macLan?: string;
  macWifi?: string;
  cnCode?: string;
  manufactureDate?: string;
  electricalRating?: string;
  cmiitId?: string;
  detectedBarcodes?: DetectedBarcode[];
  notes?: string;
}

export interface ScannedRecord {
  id: string;
  timestamp: string;
  codeType: 'QR_CODE' | 'BARCODE' | 'AI_LABEL';
  qrCode?: string;
  assetTag?: string;
  company?: string;
  licenseKey?: string;
  serialNumber: string;
  partNumber: string;
  macLan: string;
  macWifi: string;
  model: string;
  salesModelName: string;
  mainBarcode: string;
  detectedBarcodesCount: number;
  barcodesSummary: string;
  notes: string;
  rawImage?: string;
  syncedToSheets: boolean;
  syncedAt?: string;
  sheetRowIndex?: number;
  syncError?: string;
}

export interface SpreadsheetMeta {
  id: string;
  name: string;
  modifiedTime?: string;
  url: string;
  sheets?: Array<{
    sheetId: number;
    title: string;
    rowCount: number;
  }>;
}
