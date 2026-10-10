import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: true, limit: '30mb' }));

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Multimodal AI barcode & label scanner endpoint
app.post('/api/scan-label', async (req, res) => {
  try {
    const { imageBase64, mimeType = 'image/jpeg' } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'Missing imageBase64 in request body' });
    }

    // Clean base64 if data URI prefix is included
    const cleanedBase64 = imageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');

    const prompt = `Bạn là một chuyên gia OCR, đọc mã QR và máy quét mã vạch công nghiệp hàng đầu.
Nhiệm vụ của bạn là phân tích hình ảnh tem nhãn thiết bị phần cứng, tem máy tính (Dell, ASUS, HP, NUC, Lenovo), router, switch, card mạng, thiết bị văn phòng.
Hãy đọc CHÍNH XÁC toàn bộ các mã QR code, mã vạch (1D barcode như Code 128, Code 39) và các thông tin in trên tem:

QUY TẮC PHÂN LOẠI QUAN TRỌNG:
1. Serial Number (S/N hay Seri):
   - Chuỗi số serial của thiết bị, thường có mã vạch riêng hoặc dòng chữ S/N, Serial, Seri, Service Tag.
   - Ví dụ: TCARAC00A158JFH, 8SSN1234567, CN-0ABCD1-12345.

2. MAC Address LAN (LAN1 / Ethernet MAC):
   - Chuỗi 12 ký tự hexadecimal (ví dụ: 48210B7CB84B hoặc 48:21:0B:7C:B8:4B hoặc 48-21-0B-7C-B8-4B).
   - Thường có mã vạch kèm chữ LAN, LAN1, ETH, MAC, hoặc là địa chỉ MAC đầu tiên trên tem nhãn.

3. MAC Address WiFi (WLAN / WiFi MAC):
   - Chuỗi 12 ký tự hexadecimal (ví dụ: 381868940999 hoặc 38:18:68:94:09:99).
   - Thường có mã vạch kèm chữ WLAN, WIFI, hoặc là địa chỉ MAC thứ hai trên tem nhãn.

4. Mã QR Code (nếu có):
   - Nội dung giải mã của mã QR trên hình ảnh (ví dụ: 3300021371, link, text phân tách bởi dấu phẩy như 3300021371, POUYUEN, PC-DELL).

5. Danh sách detectedBarcodes:
   - Hãy liệt kê TẤT CẢ các mã vạch (1D và 2D) nhìn thấy trên hình kèm theo loại field: "Serial Number", "MAC LAN", "MAC WiFi", "QR Code", "Part Number" và định dạng mã (CODE_128, CODE_39, QR_CODE, DATA_MATRIX, v.v.).

Nếu trường nào không có trên hình ảnh, để chuỗi rỗng "". Trích xuất chính xác 100% từng ký tự chữ hoa, số và dấu gạch nối.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: {
        parts: [
          {
            inlineData: {
              data: cleanedBase64,
              mimeType: mimeType || 'image/jpeg',
            },
          },
          {
            text: prompt,
          },
        ],
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            qrCode: { type: Type.STRING, description: 'Nội dung hoặc mã của QR code, vd: 3300021371 hoặc link/text' },
            assetTag: { type: Type.STRING, description: 'Mã tài sản quản lý, vd: 3300021371' },
            company: { type: Type.STRING, description: 'Tên công ty/đơn vị, vd: POUYUEN VIETNAM COMPANY' },
            licenseKey: { type: Type.STRING, description: 'Product key phần mềm nếu có, vd: WNB87-23DQW-F7XD9-V84TG-23722' },
            brand: { type: Type.STRING, description: 'Hãng sản xuất, vd: ASUS, Microsoft, Pouyuen' },
            model: { type: Type.STRING, description: 'Model thiết bị hoặc phiên bản OS, vd: NUC13ANH, Windows 11 Pro' },
            salesModelName: { type: Type.STRING, description: 'Sales Model Name, vd: RNUC13ANHH5000001' },
            serialNumber: { type: Type.STRING, description: 'Số Serial S/N, vd: TCARAC00A158JFH' },
            partNumber: { type: Type.STRING, description: 'Mã linh kiện P/N, vd: 90AR00C1-M002X0, FQC-10528' },
            macLan: { type: Type.STRING, description: 'MAC Address (LAN1), vd: 48210B7CB84B' },
            macWifi: { type: Type.STRING, description: 'MAC Address (WiFi), vd: 381868940999' },
            cnCode: { type: Type.STRING, description: 'Mã CN hoặc Revision, vd: AA7J' },
            manufactureDate: { type: Type.STRING, description: 'Ngày sản xuất, vd: 12/2025' },
            electricalRating: { type: Type.STRING, description: 'Nguồn điện, vd: 20V --- 6A' },
            cmiitId: { type: Type.STRING, description: 'CMIIT ID nếu có' },
            detectedBarcodes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  field: { type: Type.STRING, description: 'Trường tương ứng, vd: QR Code Tài sản, S/N, P/N, MAC, Key' },
                  value: { type: Type.STRING, description: 'Giá trị mã đọc được' },
                  format: { type: Type.STRING, description: 'Định dạng mã, vd: QR_CODE, CODE_128, DATA_MATRIX' },
                },
                required: ['field', 'value'],
              },
              description: 'Tất cả các mã QR và mã vạch đọc được trên hình ảnh',
            },
            notes: { type: Type.STRING, description: 'Ghi chú tóm tắt' },
          },
          required: ['detectedBarcodes'],
        },
      },
    });

    const parsed = JSON.parse(response.text || '{}');
    return res.json({ success: true, data: parsed });
  } catch (error: any) {
    console.error('Error scanning label with Gemini:', error);
    return res.status(500).json({
      error: error.message || 'Lỗi khi quét nhãn với Gemini AI',
    });
  }
});

// Setup Vite middleware in dev or static files in production
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Scanner server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
