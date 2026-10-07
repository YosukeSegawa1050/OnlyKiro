# GoogleカレンダーでChatGPTから予定を追加する

RoundScheduleのGoogle連携は、Googleカレンダーの予定をこの画面に同期します。ChatGPTで同じカレンダーに追加した予定は「予定を同期」または画面復帰時・約2分ごとの同期で表示されます。RoundScheduleのサーバーを外部へ公開する必要はありません。Googleカレンダーに保存する予定の内容はGoogleに送信されます。

## 準備

1. [Google Cloud Console](https://console.cloud.google.com/)でプロジェクトを用意し、**Google Calendar API**を有効にします。
2. OAuth同意画面を設定します。テスト利用では、このアプリを使うGoogleアカウントをテストユーザーに追加します。
3. OAuthクライアントを**ウェブアプリケーション**として作成します。「承認済みのJavaScript生成元」に、RoundScheduleを開くURLのoriginを完全一致で登録します。ローカル起動の既定値は `http://127.0.0.1:8765` です。`localhost` と `127.0.0.1` は別のoriginです。
4. Googleカレンダー側で「RoundSchedule」などの専用カレンダーを作成します。既に予定の保存に使いたい書き込み可能なカレンダーがあれば、それを選ぶこともできます。
5. RoundScheduleの「Google連携」を開き、OAuthクライアントIDを入力してGoogleアカウントに接続し、専用カレンダーを選んで同期します。**クライアントシークレットは入力しません。**
6. ChatGPTでもGoogleカレンダー連携に同じGoogleアカウントを許可します。たとえば「Googleカレンダーの『RoundSchedule』に、明日14時から15時の打ち合わせを追加して」と依頼します。

Googleの設定資料: [ウェブ用クライアントID](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid)、[ブラウザーからの認可](https://developers.google.com/identity/oauth2/web/guides/use-token-model)、[Calendar API](https://developers.google.com/workspace/calendar/api/guides/create-events)。

## 予定の扱い

- Googleカレンダーの単発の日時付き・終日予定は日付にかかわらず同期します。Googleの繰り返し予定は、過去1年から今後2年の各回を個別の予定として表示します。
- Google連携中にRoundScheduleから新しい日時付き・終日予定を作る場合、「Googleカレンダーに保存」を選べます。同期したGoogle予定の変更・削除はGoogleへ反映されます。
- 既存の端末内予定を移すボタンは、繰り返しのない日時付き・終日予定だけを対象にします。Googleへの保存に成功したものから端末内の元データを取り除きます。再実行時はRoundScheduleの予定IDを使って重複登録を避けます。移行前に「設定・データ」からバックアップJSONを保存できます。
- 時刻未定、RoundSchedule独自の繰り返し、カテゴリー、状態、テンプレート、通知設定は端末内データとして扱います。ChatGPTから追加した予定は先頭のカテゴリーになります。Googleで作成した繰り返し予定は各回として表示されるため、RoundScheduleから繰り返し全体の編集はできません。
- Googleアカウントのアクセストークンはメモリだけに置き、再読み込み後は再接続が必要です。クライアントIDと選択したカレンダーIDだけをブラウザーに保存します。連携解除はこの端末のGoogle予定の表示を消し、Googleカレンダー上の予定は削除しません。
- Googleの予定を編集する際は変更前の版を照合します。他の画面で変更されていた場合は同期して開き直してください。

ChatGPT側のGoogleカレンダー連携と、RoundSchedule側のGoogleアクセス許可はそれぞれ個別に必要です。
