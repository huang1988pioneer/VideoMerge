# VideoMerge

瀏覽器端影片工具：預覽每段影片的**首幀 / 尾幀**，並可將**多段影片合併**成一個 MP4。

所有處理都在本機完成（Canvas 擷取影格 + FFmpeg.wasm），不會上傳到伺服器。

## 功能

- 拖曳或選擇多個影片
- 自動顯示每段的首幀、尾幀縮圖與時長 / 解析度
- 調整合併順序（上移 / 下移）
- 一鍵合併為 MP4 並預覽、下載

## 使用方式

```bash
npm install
npm run dev
```

瀏覽器開啟終端機顯示的本機網址（通常是 `http://localhost:5173`）。

建置：

```bash
npm run build
npm run preview
```

## 技術

| 項目 | 說明 |
|------|------|
| Vite | 開發與建置 |
| HTML5 Video + Canvas | 擷取首尾幀 |
| FFmpeg.wasm | 標準化解析度 / 幀率後串接影片 |

合併時會將各片段標準化為 1280×720、30fps、H.264 + AAC，以相容不同來源編碼。

## 注意事項

- 首次合併需下載 FFmpeg 核心（約數十 MB），之後可走快取
- 長影片或很多片段時，瀏覽器內轉檔會較慢，屬正常現象
- 建議使用較新的 Chrome / Edge / Firefox
