import React, { useState, useEffect } from 'react';
import {
  FileSpreadsheet,
  Plus,
  ExternalLink,
  RefreshCw,
  Trash2,
  CheckCircle2,
  AlertCircle,
  FolderOpen,
  ArrowRight,
  LogOut,
  User as UserIcon,
} from 'lucide-react';
import { User } from 'firebase/auth';
import {
  createNewSpreadsheet,
  listUserSpreadsheets,
  fetchSheetRows,
  deleteSheetRow,
  getSpreadsheetDetails,
  getOrCreateValidSpreadsheet,
} from '../services/sheets';
import { logout } from '../services/auth';

interface SheetsManagerProps {
  user: User | null;
  onLoginRequest: () => void;
  activeSpreadsheetId: string | null;
  activeSpreadsheetTitle: string;
  activeTabName: string;
  onSelectSpreadsheet: (id: string, title: string, tabName: string) => void;
  isSyncing: boolean;
  refreshTrigger: number;
  onLiveRowsLoaded?: (rows: string[][]) => void;
}

export const SheetsManager: React.FC<SheetsManagerProps> = ({
  user,
  onLoginRequest,
  activeSpreadsheetId,
  activeSpreadsheetTitle,
  activeTabName,
  onSelectSpreadsheet,
  isSyncing,
  refreshTrigger,
  onLiveRowsLoaded,
}) => {
  const [spreadsheetsList, setSpreadsheetsList] = useState<
    Array<{ id: string; name: string; modifiedTime: string; url: string }>
  >([]);
  const [loadingList, setLoadingList] = useState(false);
  const [isCreatingSheet, setIsCreatingSheet] = useState(false);
  const [liveRows, setLiveRows] = useState<string[][]>([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Destructive row deletion confirmation modal state
  const [rowToDelete, setRowToDelete] = useState<{
    rowIndex: number;
    serial: string;
    sheetId: number;
  } | null>(null);
  const [isDeletingRow, setIsDeletingRow] = useState(false);
  const [currentSheetTabId, setCurrentSheetTabId] = useState<number>(0);

  // Load existing spreadsheets
  const loadExistingSheets = async () => {
    if (!user) return;
    try {
      setLoadingList(true);
      setErrorMessage(null);
      const list = await listUserSpreadsheets();
      setSpreadsheetsList(list);
    } catch (err: any) {
      console.error('Failed to load spreadsheets:', err);
    } finally {
      setLoadingList(false);
    }
  };

  // Load live rows from active spreadsheet
  const loadLiveRows = async () => {
    if (!user || !activeSpreadsheetId) return;
    try {
      setLoadingRows(true);
      setErrorMessage(null);

      // Get sheet tab id for deletion if needed
      const details = await getSpreadsheetDetails(activeSpreadsheetId);
      const activeTab = details.sheets.find((s: { title: string; sheetId: number }) => s.title === activeTabName) || details.sheets[0];
      if (activeTab) {
        setCurrentSheetTabId(activeTab.sheetId);
      }

      const result = await fetchSheetRows(activeSpreadsheetId, activeTabName);
      setLiveRows(result.rows);
      if (onLiveRowsLoaded) {
        onLiveRowsLoaded(result.rows);
      }
    } catch (err: any) {
      console.warn('Could not load live rows:', err);
      const isNotFound =
        err.message?.includes('404') ||
        err.message?.toLowerCase().includes('not found') ||
        err.message?.includes('không tìm thấy');

      if (isNotFound) {
        console.warn('Bảng tính cũ không tìm thấy, tự động tạo bảng mới...');
        try {
          const newSheet = await getOrCreateValidSpreadsheet(null);
          onSelectSpreadsheet(newSheet.id, newSheet.title, newSheet.tabName);
          return;
        } catch (recoverErr: any) {
          setErrorMessage(recoverErr.message || 'Không thể tạo bảng tính mới.');
        }
      } else {
        setErrorMessage(err.message || 'Không thể đồng bộ bảng tính trực tiếp.');
      }
    } finally {
      setLoadingRows(false);
    }
  };

  // Handle creating a new Google Sheet
  const handleCreateNewSheet = async () => {
    if (!user) {
      onLoginRequest();
      return;
    }

    try {
      setIsCreatingSheet(true);
      setErrorMessage(null);
      const newSheet = await createNewSpreadsheet('Sổ Quét Mã Barcode & Serial');
      onSelectSpreadsheet(newSheet.id, newSheet.title, newSheet.tabName);
      await loadExistingSheets();
      await loadLiveRows();
    } catch (err: any) {
      console.error('Error creating sheet:', err);
      setErrorMessage(err.message || 'Không thể tạo bảng tính mới');
    } finally {
      setIsCreatingSheet(false);
    }
  };

  // Handle row deletion with explicit confirmation
  const handleConfirmDeleteRow = async () => {
    if (!rowToDelete || !activeSpreadsheetId) return;
    try {
      setIsDeletingRow(true);
      await deleteSheetRow(activeSpreadsheetId, rowToDelete.sheetId, rowToDelete.rowIndex);
      setRowToDelete(null);
      await loadLiveRows();
    } catch (err: any) {
      alert(`Lỗi khi xóa hàng: ${err.message}`);
    } finally {
      setIsDeletingRow(false);
    }
  };

  useEffect(() => {
    if (user) {
      loadExistingSheets();
    }
  }, [user]);

  useEffect(() => {
    if (activeSpreadsheetId) {
      loadLiveRows();
    }
  }, [activeSpreadsheetId, activeTabName, refreshTrigger]);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl">
      {/* Top Bar: Google Auth & Sheet Selector */}
      <div className="p-4 sm:p-5 border-b border-slate-800 bg-slate-950 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-emerald-600/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
            <FileSpreadsheet className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
              Đồng Bộ Google Sheets
              {activeSpreadsheetId && (
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                  Đang kết nối
                </span>
              )}
            </h2>
            <p className="text-xs text-slate-400">
              Ghi tự động dữ liệu camera theo thời gian thực vào bảng tính
            </p>
          </div>
        </div>

        {/* User Auth Info or Sign in Button */}
        <div>
          {user ? (
            <div className="flex items-center gap-2.5 bg-slate-800/80 p-1.5 pr-3 rounded-2xl border border-slate-700/80">
              {user.photoURL ? (
                <img
                  src={user.photoURL}
                  alt={user.displayName || 'Google User'}
                  className="w-7 h-7 rounded-xl object-cover"
                />
              ) : (
                <div className="w-7 h-7 rounded-xl bg-blue-600 text-white flex items-center justify-center text-xs font-bold">
                  <UserIcon className="w-4 h-4" />
                </div>
              )}
              <div className="text-left text-xs">
                <span className="block font-medium text-white truncate max-w-[120px] sm:max-w-[180px]">
                  {user.displayName || user.email}
                </span>
              </div>
              <button
                type="button"
                onClick={() => logout()}
                title="Đăng xuất"
                className="p-1 text-slate-400 hover:text-rose-400 transition-colors ml-1"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onLoginRequest}
              className="gsi-material-button inline-flex items-center justify-center gap-2.5 px-4 py-2 rounded-2xl bg-white hover:bg-slate-100 text-slate-800 font-medium text-xs shadow-md transition-all active:scale-95 cursor-pointer"
            >
              <svg className="w-4 h-4" viewBox="0 0 48 48">
                <path
                  fill="#EA4335"
                  d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                />
                <path
                  fill="#4285F4"
                  d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                />
                <path
                  fill="#FBBC05"
                  d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                />
                <path
                  fill="#34A853"
                  d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                />
              </svg>
              <span>Đăng nhập với Google</span>
            </button>
          )}
        </div>
      </div>

      {/* Sheet Management Controls */}
      <div className="p-4 sm:p-5 bg-slate-900/60 border-b border-slate-800 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex-1 min-w-[240px] flex items-center gap-2">
            <select
              value={activeSpreadsheetId || ''}
              onChange={(e) => {
                const selected = spreadsheetsList.find((s) => s.id === e.target.value);
                if (selected) {
                  onSelectSpreadsheet(selected.id, selected.name, 'LichSuQuet');
                }
              }}
              disabled={!user || loadingList}
              className="w-full bg-slate-950 border border-slate-700 rounded-2xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-50"
            >
              <option value="" disabled>
                {loadingList ? 'Đang tải danh sách Google Sheets...' : '-- Chọn Bảng Tính Google Sheets --'}
              </option>
              {spreadsheetsList.map((s) => (
                <option key={s.id} value={s.id}>
                  📄 {s.name}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={loadExistingSheets}
              disabled={!user || loadingList}
              title="Làm mới danh sách bảng tính"
              className="p-2.5 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loadingList ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCreateNewSheet}
              disabled={isCreatingSheet}
              className="px-4 py-2.5 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs flex items-center gap-2 shadow-md shadow-emerald-600/20 active:scale-95 transition-all disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              {isCreatingSheet ? 'Đang tạo bảng...' : 'Tạo Bảng Tính Mới'}
            </button>

            {activeSpreadsheetId && (
              <a
                href={`https://docs.google.com/spreadsheets/d/${activeSpreadsheetId}/edit`}
                target="_blank"
                rel="noreferrer"
                className="px-3.5 py-2.5 rounded-2xl bg-slate-800 hover:bg-slate-700 text-blue-400 font-medium text-xs flex items-center gap-1.5 border border-slate-700 transition-colors"
              >
                <span>Mở Sheet</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        </div>

        {/* Current Active Sheet Info */}
        {activeSpreadsheetId ? (
          <div className="p-3 rounded-2xl bg-slate-950/80 border border-slate-800/80 flex flex-wrap items-center justify-between text-xs text-slate-300 gap-2">
            <div className="flex items-center gap-2">
              <span className="text-slate-400">Đang đồng bộ vào:</span>
              <span className="font-semibold text-white">{activeSpreadsheetTitle}</span>
              <span className="px-2 py-0.5 rounded-md bg-slate-800 text-emerald-400 text-[11px] font-mono">
                Tab: {activeTabName}
              </span>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-[11px] text-slate-400">
                {liveRows.length > 1 ? `${liveRows.length - 1} dòng dữ liệu` : 'Chưa có dòng dữ liệu'}
              </span>
              <button
                type="button"
                onClick={loadLiveRows}
                disabled={loadingRows}
                className="text-xs text-blue-400 hover:text-blue-300 font-medium flex items-center gap-1"
              >
                <RefreshCw className={`w-3 h-3 ${loadingRows ? 'animate-spin' : ''}`} />
                Làm mới
              </button>
            </div>
          </div>
        ) : (
          <div className="p-3 rounded-2xl bg-amber-950/30 border border-amber-800/40 text-amber-300 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>
              Chưa có bảng tính nào được chọn. Nhấn <strong>"Tạo Bảng Tính Mới"</strong> hoặc chọn một bảng từ danh sách bên trên để bắt đầu ghi tự động.
            </span>
          </div>
        )}
      </div>

      {/* Live Sheet Data Table */}
      <div className="p-4 sm:p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            Dữ liệu trực tiếp trên Google Sheets
          </h3>

          {isSyncing && (
            <span className="text-xs text-emerald-400 font-medium flex items-center gap-1.5 animate-pulse">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              Đang ghi dữ liệu vào Sheet...
            </span>
          )}
        </div>

        {loadingRows && liveRows.length === 0 ? (
          <div className="py-12 text-center text-slate-400 text-xs flex flex-col items-center justify-center gap-2">
            <RefreshCw className="w-6 h-6 animate-spin text-blue-400" />
            <span>Đang nạp dữ liệu từ Google Sheets...</span>
          </div>
        ) : liveRows.length > 0 ? (
          <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-900 border-b border-slate-800 text-slate-400 font-semibold">
                  <th className="p-3 text-center w-12">#</th>
                  {liveRows[0].map((header, idx) => (
                    <th key={idx} className="p-3 whitespace-nowrap">
                      {header}
                    </th>
                  ))}
                  <th className="p-3 text-center w-16">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono">
                {liveRows.slice(1).map((row, rIndex) => (
                  <tr
                    key={rIndex}
                    className="hover:bg-slate-900/60 transition-colors text-slate-300"
                  >
                    <td className="p-3 text-center text-slate-500 font-sans text-[11px]">
                      {rIndex + 1}
                    </td>
                    {row.map((cell, cIndex) => (
                      <td
                        key={cIndex}
                        className={`p-3 max-w-[200px] truncate ${
                          cIndex === 1
                            ? 'font-bold text-white'
                            : cIndex === 2
                            ? 'text-indigo-300'
                            : cIndex === 3 || cIndex === 4
                            ? 'text-emerald-300'
                            : ''
                        }`}
                        title={cell}
                      >
                        {cell || '—'}
                      </td>
                    ))}
                    <td className="p-3 text-center">
                      <button
                        type="button"
                        onClick={() =>
                          setRowToDelete({
                            rowIndex: rIndex + 2, // 1-indexed including header
                            serial: row[1] || `Hàng #${rIndex + 1}`,
                            sheetId: currentSheetTabId,
                          })
                        }
                        title="Xóa hàng này khỏi Google Sheets"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-12 text-center text-slate-500 text-xs border border-dashed border-slate-800 rounded-2xl p-6">
            <FileSpreadsheet className="w-8 h-8 mx-auto mb-2 text-slate-600" />
            <p className="font-medium text-slate-400">Bảng tính đang trống</p>
            <p className="text-[11px] mt-1 text-slate-500">
              Hãy dùng camera để quét mã vạch hoặc tem nhãn ASUS NUC ở trên để tự động thêm dữ liệu.
            </p>
          </div>
        )}
      </div>

      {/* Mandatory User Confirmation Modal for Destructive Row Deletion */}
      {rowToDelete && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-3xl p-6 max-w-md w-full shadow-2xl text-left space-y-4">
            <div className="flex items-center gap-3 text-rose-400">
              <div className="w-10 h-10 rounded-2xl bg-rose-500/20 border border-rose-500/40 flex items-center justify-center">
                <Trash2 className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-white">Xác nhận xóa hàng dữ liệu</h3>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              Bạn có chắc chắn muốn xóa dòng <strong>{rowToDelete.serial}</strong> (Hàng #{rowToDelete.rowIndex}) khỏi Google Sheets không? Hành động này sẽ thay đổi dữ liệu trên Google Sheets của bạn.
            </p>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setRowToDelete(null)}
                disabled={isDeletingRow}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium text-xs transition-colors"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteRow}
                disabled={isDeletingRow}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs flex items-center gap-1.5 shadow-md shadow-rose-600/30 transition-colors"
              >
                {isDeletingRow ? 'Đang xóa...' : 'Xóa khỏi Google Sheets'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
