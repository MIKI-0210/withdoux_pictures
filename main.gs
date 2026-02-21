// ============================================================
// Sizzle Cake App - main.gs
// Version: 2.0
// ============================================================

function doGet() {
  return HtmlService.createTemplateFromFile('index').evaluate()
    .setTitle('Sizzle Cake 🎂')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ------------------------------------------------------------
// メイン処理: 背景削除 + 比率調整
// ------------------------------------------------------------
function mainProcess(data) {
  const props = PropertiesService.getScriptProperties();
  const cloudName = props.getProperty('CLOUD_NAME');
  const apiKey    = props.getProperty('API_KEY');
  const apiSecret = props.getProperty('API_SECRET');

  const timestamp = Math.round(new Date().getTime() / 1000).toString();

  // 比率に応じた出力サイズ
  let width, height;
  if      (data.ratio === '1:1')  { width = 1000; height = 1000; }
  else if (data.ratio === '4:5')  { width = 800;  height = 1000; }
  else                            { width = 1600; height = 900;  }

  const uploadPreset   = 'mikicake';
  const transformation = `c_pad,w_${width},h_${height},b_transparent,f_png`;

  // ★ public_id を明示指定（スラッシュ不使用）でエラーを回避
  const publicId = `sizzle_${timestamp}`;

  // 署名対象パラメータ（アルファベット順で並べること）
  // ★ display_name も明示指定してプリセットの自動生成（スラッシュ含む）を上書き
  const paramsToSign = {
    background_removal: 'cloudinary_ai',
    display_name:        publicId,
    public_id:           publicId,
    timestamp:           timestamp,
    transformation:      transformation,
    upload_preset:       uploadPreset,
  };

  const signature = generateSignature(paramsToSign, apiSecret);
  const url = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;

  const payload = {
    file:               data.image,
    api_key:            apiKey,
    timestamp:          timestamp,
    signature:          signature,
    background_removal: 'cloudinary_ai',
    display_name:       publicId,
    public_id:          publicId,
    transformation:     transformation,
    upload_preset:      uploadPreset,
  };

  const options = { method: 'post', payload: payload, muteHttpExceptions: true };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const json     = JSON.parse(response.getContentText());

    if (response.getResponseCode() !== 200) {
      const msg = json.error ? json.error.message : '不明なエラー';
      return { success: false, error: `Cloudinary Error: ${msg}` };
    }

    const uploadedPublicId = json.public_id;

    // cloudinary_ai は非同期処理のため、完了するまでポーリングして待機する
    // Admin API で background_removal.status を確認（最大10回 × 3秒 = 30秒）
    const checkUrl = `https://api.cloudinary.com/v1_1/${cloudName}/resources/image/upload/${encodeURIComponent(uploadedPublicId)}`;
    const checkHeaders = {
      'Authorization': 'Basic ' + Utilities.base64Encode(`${apiKey}:${apiSecret}`)
    };

    for (let i = 0; i < 10; i++) {
      Utilities.sleep(3000); // 3秒待機

      const checkResp = UrlFetchApp.fetch(checkUrl, {
        method: 'get',
        headers: checkHeaders,
        muteHttpExceptions: true
      });
      const checkJson = JSON.parse(checkResp.getContentText());

      // background_removal の完了ステータスを確認
      const bgInfo   = checkJson.info && checkJson.info.background_removal;
      const bgStatus = bgInfo && bgInfo.cloudinary_ai && bgInfo.cloudinary_ai.status;

      if (bgStatus === 'complete') {
        // 完了 → 透過PNG URLを返す
        const pngUrl = checkJson.secure_url.replace(/\.[^/.]+$/, '.png');
        return { success: true, url: pngUrl, publicId: uploadedPublicId };
      }

      if (bgStatus === 'failed') {
        return { success: false, error: '背景削除処理が失敗しました (cloudinary_ai)' };
      }
      // pending の場合はループ継続
    }

    // タイムアウト時はアップロード済みURLをそのまま返す（背景未削除の可能性あり）
    const fallbackUrl = json.secure_url.replace(/\.[^/.]+$/, '.png');
    return { success: true, url: fallbackUrl, publicId: uploadedPublicId, warning: 'timeout' };

  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// ------------------------------------------------------------
// 背景合成処理（位置・スケール・複製対応版）
// data.scale: 0.1〜3.0（1.0 = キャンバスの80%）
// data.x, data.y: 中心からのオフセット（Cloudinaryピクセル）
// data.copies: [{scale, x, y}] 追加コピー配列
// ------------------------------------------------------------
function compositeProcess(data) {
  const props = PropertiesService.getScriptProperties();
  const cloudName = props.getProperty('CLOUD_NAME');

  let width, height;
  if      (data.ratio === '1:1') { width = 1000; height = 1000; }
  else if (data.ratio === '4:5') { width = 800;  height = 1000; }
  else                           { width = 1600; height = 900;  }

  const fgSafe  = data.fgPublicId.replace(/\//g, ':');
  const scale   = data.scale || 1.0;
  // Cloudinaryはキャンバス幅を超えるオーバーレイを拒否するためクランプ
  const overlayW = Math.min(Math.round(width * 0.8 * scale), width);
  const xOff    = Math.round(data.x || 0);
  const yOff    = Math.round(data.y || 0);

  // 追加コピーのオーバーレイ層を生成
  let extraLayers = '';
  if (data.copies && Array.isArray(data.copies)) {
    data.copies.forEach(function(copy) {
      // コピー幅もクランプ
      const cW = Math.min(Math.round(width * 0.8 * (copy.scale || 0.5)), width);
      const cx = Math.round(copy.x || 0);
      const cy = Math.round(copy.y || 0);
      extraLayers += 'l_' + fgSafe + ',w_' + cW + ',c_fit/fl_layer_apply,g_center,x_' + cx + ',y_' + cy + '/';
    });
  }

  let compositeUrl;

  if (data.bgType === 'preset') {
    // ベース fg を 1px に縮小（実質不可視）→ bg色でキャンバスを生成
    // メイン + コピー を全てオーバーレイとして追加（fg が 1回だけ表示）
    compositeUrl =
      'https://res.cloudinary.com/' + cloudName + '/image/upload/' +
      'w_1,c_fit/' +
      'b_rgb:' + data.bgColor + ',c_pad,w_' + width + ',h_' + height + ',f_png/' +
      'l_' + fgSafe + ',w_' + overlayW + ',c_fit/fl_layer_apply,g_center,x_' + xOff + ',y_' + yOff + '/' +
      extraLayers +
      data.fgPublicId;

  } else {
    // カスタム背景: 背景画像がベース、fgをオーバーレイ（元から二重表示なし）
    compositeUrl =
      'https://res.cloudinary.com/' + cloudName + '/image/upload/' +
      'w_' + width + ',h_' + height + ',c_fill/' +
      'l_' + fgSafe + ',w_' + overlayW + ',c_fit/fl_layer_apply,g_center,x_' + xOff + ',y_' + yOff + '/' +
      extraLayers +
      data.bgPublicId;
  }

  try {
    const response = UrlFetchApp.fetch(compositeUrl, { muteHttpExceptions: true });

    if (response.getResponseCode() !== 200) {
      return { success: false, error: `合成URL取得エラー (${response.getResponseCode()}): ${compositeUrl}` };
    }

    const blob     = response.getBlob();
    const base64   = Utilities.base64Encode(blob.getBytes());
    const mimeType = blob.getContentType() || 'image/png';

    return {
      success: true,
      url:     compositeUrl,
      dataUrl: `data:${mimeType};base64,${base64}`,
    };

  } catch (e) {
    return { success: false, error: e.toString() };
  }
}



// ------------------------------------------------------------
// ダウンロード用プロキシ: GAS側でCloudinary画像をBase64化して返す
// CORSを回避するためサーバー経由でフェッチ
// ------------------------------------------------------------
function fetchImageAsBase64(imageUrl) {
  try {
    const response = UrlFetchApp.fetch(imageUrl);
    const blob     = response.getBlob();
    const base64   = Utilities.base64Encode(blob.getBytes());
    const mimeType = blob.getContentType() || 'image/png';
    return { success: true, dataUrl: `data:${mimeType};base64,${base64}` };
  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// ------------------------------------------------------------
// 背景画像をCloudinaryにアップロードしてpublic_idを返す
// （カスタム背景アップロード用）
// ------------------------------------------------------------
function uploadBackground(data) {
  const props = PropertiesService.getScriptProperties();
  const cloudName = props.getProperty('CLOUD_NAME');
  const apiKey    = props.getProperty('API_KEY');
  const apiSecret = props.getProperty('API_SECRET');

  const timestamp = Math.round(new Date().getTime() / 1000).toString();
  const publicId  = `sizzle_bg_${timestamp}`;
  const uploadPreset = 'mikicake';

  const paramsToSign = {
    public_id:     publicId,
    timestamp:     timestamp,
    upload_preset: uploadPreset,
  };

  const signature = generateSignature(paramsToSign, apiSecret);
  const url = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;

  const payload = {
    file:          data.image,
    api_key:       apiKey,
    timestamp:     timestamp,
    signature:     signature,
    public_id:     publicId,
    upload_preset: uploadPreset,
  };

  const options = { method: 'post', payload: payload, muteHttpExceptions: true };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const json     = JSON.parse(response.getContentText());

    if (response.getResponseCode() !== 200) {
      const msg = json.error ? json.error.message : '不明なエラー';
      return { success: false, error: msg };
    }

    return { success: true, publicId: json.public_id, url: json.secure_url };

  } catch (e) {
    return { success: false, error: e.toString() };
  }
}

// ------------------------------------------------------------
// SHA-1署名生成
// ------------------------------------------------------------
function generateSignature(params, apiSecret) {
  const queryString = Object.keys(params).sort().map(key => {
    return `${key}=${params[key]}`;
  }).join('&') + apiSecret;

  const signature = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_1,
    queryString,
    Utilities.Charset.UTF_8
  );

  return signature.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}
