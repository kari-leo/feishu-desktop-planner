require("dotenv").config();

const Lark = require("@larksuiteoapi/node-sdk");

const config = {
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
};

if (!config.appId || !config.appSecret) {
  throw new Error("缺少飞书应用凭证");
}

const wsClient = new Lark.WSClient({
  ...config,
  loggerLevel: Lark.LoggerLevel.debug,
});

const eventDispatcher = new Lark.EventDispatcher({})
  .register({

    // 多维表格记录变更
    "drive.file.bitable_record_changed_v1":
      async (data) => {
        console.log("\n[Bitable Record Changed]");
        console.log(JSON.stringify(data, null, 2));
      },

    // 多维表格字段变更
    "drive.file.bitable_field_changed_v1":
      async (data) => {
        console.log("\n[Bitable Field Changed]");
        console.log(JSON.stringify(data, null, 2));
      },

    // 飞书日程变更
    "calendar.calendar.event.changed_v4":
      async (data) => {
        console.log("\n[Calendar Event Changed]");
        console.log(JSON.stringify(data, null, 2));
      },
  });

wsClient.start({
  eventDispatcher,
});

console.log("正在建立飞书 WebSocket 长连接...");
