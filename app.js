/*
    IBM Confidential
    OCO Source Materials
    6949-63A
    (c) Copyright IBM Corp. 2016
*/

'use strict';

/*****************************************************************************
Define Valuable Section
*****************************************************************************/
// app.js 内で利用する変数を定義する
var express = require('express'); // express
var watson = require('watson-developer-cloud'); // watson developer cloud
var bluemix      = require('./config/bluemix');
var extend       = require('util')._extend;
var basicAuth = require('basic-auth-connect'); // 基本認証用
var _ = require("underscore");  // アンダースコア
var fs = require('fs');  // ファイル操作用
var multer  = require('multer');  // ファイルアップロード用
var upload = multer({ dest: 'uploads/' });  // ファイルアップロードの配置場所を定義
var csv = require("ya-csv");  // csv 操作用
var credentials_NLC;  // NLC のクレデンシャル
var credentials_DB;  // SQL DB のクレデンシャル
var classifiers = [];  // NLC クラシファイのリスト
var classifiers_status = [];  // NLC クラシファイのリストにステータスを追加
var pre_classify_params;  // pre_classifierのパラメータ
var final_classify_params; // final_classifierのパラメータ
var services;  // Bluemixサービスの定義を格納
var answerstore_name;  // アンサーストア名を定義
var answerstore_data = [];  // アンサーストアのデータを格納
var defaultArray = [];  // アンサーストア内のデフォルトアンサーを格納
var classifierThresholdValue;  // 確信度のしきい値を格納
var settingJson ={};  // classifierSettings.json のデータを格納
var auth_app = {  //  認証情報
  "client_user":"asset",   // クライアント用のユーザー名
  "client_password":"asset2015",  //クライアント用のパスワード
  "manage_user":"assetmanage",  // 管理用のユーザー名
  "manage_password":"assetmanage2015" // 管理用のパスワード
}
var cfenv = require('cfenv');  // cfenv provides access to your Cloud Foundry environment
var app = express();  // create a new express server
var ipArray = [  //アクセスを許可するIPアドレスの配列.許可するIPの第2オクテットまで指定する
  '203.999',
  '203.141',
  '203.888'
];

// Basic Authentication
app.all('/manage/*', basicAuth(function(user, password) {
  return user === auth_app.manage_user && password === auth_app.manage_password;
}));
//// クライアント用の認証を有効にするには、以下4行のコメントを外す ////
//app.all('/*', basicAuth(function(user, password) {
//  return (user === auth_app.client_user && password === auth_app.client_password) ||
//  (user === auth_app.manage_user && password === auth_app.manage_password);
//}));

//app.use(basicAuth(auth_app.client_user, auth_app.client_password));
var bodyParser = require('body-parser');
app.use(express.static(__dirname + '/public'));  // serve the files out of ./public as our main files
app.use('/uploads', express.static('uploads'));  //  ダウンロードファイル用　uploads フォルダ
app.use(bodyParser.urlencoded({limit:'10mb',extended: true}));
app.use(bodyParser.json());
var appEnv = cfenv.getAppEnv();  // get the app environment from Cloud Foundry

/*****************************************************************************
Define Bluemix Credential Section
*****************************************************************************/
// Define Credentials_NLC
// if bluemix credentials exists, then override local
if (typeof process.env.VCAP_SERVICES === 'undefined') {
  services = require('./VCAP_SERVICES.json');
  credentials_NLC = extend({version : 'v1'},
  services['natural_language_classifier'][0].credentials); // VCAP_SERVICES
} else {
  credentials_NLC = extend({version : 'v1'},
  bluemix.getServiceCreds('natural_language_classifier')); // VCAP_SERVICES
}
console.log("credentials_NLC:")
console.log(credentials_NLC);
var nlClassifier = watson.natural_language_classifier(credentials_NLC);  // Create the service wrapper

/*****************************************************************************
function classifiers_getlist
*****************************************************************************/
// get the list of classifiers
classifiers_getlist(function(err) {
  if (err) console.log(err);
});
function classifiers_getlist(callback) {
  nlClassifier.list({
    options: {
      url: '/v1/classifiers',
      method: 'GET',
      json: true
    }
  }, function(err, result) {
    if (err) return callback(err);
    classifiers = result.classifiers;
    // preclassify Section
    pre_classify_params = {"classifier" : (_.find(classifiers, function(classifier) {return classifier.name == 'PRECLASSIFY'}) != undefined ? _.find(classifiers, function(classifier) {return classifier.name == 'PRECLASSIFY'}).classifier_id : null)};
    final_classify_params = {"classifier" : (_.find(classifiers, function(classifier) {return classifier.name == 'FINALCLASSIFY'}) != undefined ? _.find(classifiers, function(classifier) {return classifier.name == 'FINALCLASSIFY'}).classifier_id : null)};
    callback();
  });
}

// Credential for Connect to DB2 (dashDB対応)
if (typeof process.env.VCAP_SERVICES === 'undefined') {
  services = require('./VCAP_SERVICES.json');
  credentials_DB = services['dashDB'][0].credentials;
} else {
  credentials_DB = bluemix.getServiceCreds('dashDB'); // VCAP_SERVICES
  credentials_DB.db = "BLUDB";  // Bluemix Deploy 時になぜか必要だったので、追加。
}

var ibmdb = require('ibm_db');
var constr ="DRIVER={DB2};DATABASE=" + credentials_DB.db +";"+
"HOSTNAME="+credentials_DB.host+";"+
"UID="+credentials_DB.username+";"+
"PWD="+credentials_DB.password+";"+
"PORT="+credentials_DB.port+";PROTOCOL=TCPIP";
console.log("ibmdb constr:")
console.log(constr);

/*****************************************************************************
function answerstore_getlist
*****************************************************************************/
// get the list of answerstore
function answerstore_getlist() {
  var sql = 'SELECT "CLASS","TEXT","TEXT4SPEECH" FROM '+answerstore_name;
  ibmdb.open(constr, function (err,conn) {  // ibmdb Space
    if (err) return console.log(err);
    conn.query(sql, function (err, sqldata) {
      if (err) return console.log(err);
      answerstore_data = sqldata;
      //defaultのクラス（確信度が低いときに呼ぶ）を定義
      defaultArray = _.filter(answerstore_data, function(result){
        return result.CLASS.substr(0,7) == "default";
      });
      conn.close(function () {
        console.log('Answerstore getlist Done:');
      });
    });
  });
}

/*****************************************************************************
Function readSettings
*****************************************************************************/
// classifierSettings ファイルを読み取り、初期変数をセット
function readSettings(callback){
  fs.readFile('./classifierSettings.json', 'utf8', function(err, text){
    if (err) {
      console.log(err);
    }else{
      settingJson = JSON.parse(text);
      classifierThresholdValue = settingJson.classifierThresholdValue;
      answerstore_name = settingJson.answerstore_name;
      console.log("しきい値は"+classifierThresholdValue+"です");
      console.log("アンサーストア名は" + answerstore_name +"です");
      callback();
    }
  });
}
// Call readSettings
readSettings(answerstore_getlist);

/*****************************************************************************
Function watsonquestion
*****************************************************************************/
// Call the pre-trained classifier with body.text
// Responses are json
function watsonquestion(params, callback) {
  var question = params.text;  // 質問のテキスト
  var output_num = (params.output_num == undefined) ? 3 :  params.output_num;  // 出力回答数
  var session_id = (params.session_id == undefined) ? 0 :  params.session_id;
  var client_id = (params.client_id == undefined) ? 'public' :  params.client_id; // クライアントのID　デフォルトは、publicとする
  var chat_num = (params.chat_num == undefined) ? 0 :  params.chat_num;
  var setting_multi_answer = (params.setting_multi_answer == undefined) ? 1 :  params.setting_multi_answer;
  var watson_response = {  // Response 用変数
    "text" : question,
    "session_id" : session_id,
    "client_id" : client_id,
    "chat_num" : chat_num,
    "setting_multi_answer" : setting_multi_answer,
    "answers" : []
  }
  // 確信度が低い場合のデフォルトのアンサーを取得する。
  var defaultNum = Math.floor(defaultArray.length * Math.random());
  var defaultAnswer = (defaultArray[defaultNum] != undefined) ? defaultArray[defaultNum].TEXT : "信頼できる回答が見つかりませんでした。";
  var defaultAnswer4Speech = (defaultArray[defaultNum] != undefined) ? defaultArray[defaultNum].TEXT4SPEECH : "信頼できる回答が見つかりませんでした。";
  var nlcnotfoundAnswer = "対応するNLCがありません。"; // 対応するNLCが存在しなかった場合の応答テキスト

  if(final_classify_params.classifier == null) {
    // preclassify Section
    pre_classify_params = extend(pre_classify_params,{"text" : question});
    nlClassifier.classify(pre_classify_params, function(err, preclassify_results) {
      if (err) return callback(err);
      watson_response.preclassify = preclassify_results;
      //console.log('watsonquestion : Pre Classify: ');
      //console.log(preclassify_results);

      // preclassify の確信度がしきい値以下の場合、デフォルトのアンサーからランダムに回答する。
      if(preclassify_results.classes[0].confidence < classifierThresholdValue){
        watson_response.answers.push({
          "class" : preclassify_results.classes[0].class_name,
          "answer" : defaultAnswer,
          "answer4speech" : defaultAnswer4Speech,
          "confidence" : preclassify_results.classes[0].confidence
        });
        //console.log('watsonquestion : watson_response: ');
        //console.log(watson_response.answers);
        callback(null, watson_response); //Sends a JSON response composed of a stringified version of data
      }else{
        // get classifier_id by preclassified name
        var preclassify_result_class = _.find(classifiers, function(classifier) {return classifier.name == preclassify_results.top_class});
        // preclassify のNLCが存在しない場合の返答
        if(preclassify_result_class == undefined){
          watson_response.answers.push({
            "class" : preclassify_results.classes[0].class_name,
            "answer" : nlcnotfoundAnswer,
            "answer4speech" : "",
            "confidence" : preclassify_results.classes[0].confidence
          });
          //console.log('watsonquestion : watson_response: ');
          //console.log(watson_response.answers);
          callback(null, watson_response); //Sends a JSON response composed of a stringified version of data
        }else{
          // postclassify の結果を返す。
          var classifier_id = preclassify_result_class.classifier_id;
          var post_classify_params = {
            "classifier" : classifier_id,
            "text" : question,
          };
          nlClassifier.classify(post_classify_params, function(err, postclassify_results) {
            if (err) return callback(err);
            watson_response.postclassify = postclassify_results;
            //console.log('watsonquestion : Post Classify: ');
            //console.log(postclassify_results);

            if(postclassify_results.classes[0].confidence < classifierThresholdValue){
              watson_response.answers.push({
                "class" : postclassify_results.classes[0].class_name,
                "answer" : defaultAnswer,
                "answer4speech" : defaultAnswer4Speech,
                "confidence" : postclassify_results.classes[0].confidence
              });

            }else {
              for (var i=0;i<Math.min(output_num, postclassify_results.classes.length);i++) {
                //配列にPUSH
                var answer = _.find(answerstore_data, function(result) {
                  return result.CLASS == postclassify_results.classes[i].class_name;
                });
                watson_response.answers.push({
                  "class" : postclassify_results.classes[i].class_name,
                  "answer" : (answer == undefined) ? "アンサーストアデータが見つかりませんでした。" : answer.TEXT,
                  "answer4speech" : (answer == undefined) ? "" : answer.TEXT4SPEECH,
                  "confidence" : postclassify_results.classes[i].confidence
                });
              };
            }
            //console.log('watsonquestion : watson_response: ');
            //console.log(watson_response.answers);
            callback(null, watson_response); //Sends a JSON response composed of a stringified version of data
          });
        }
      }
    });
  }else {
    final_classify_params = extend(final_classify_params,{"text" : question});
    nlClassifier.classify(final_classify_params, function(err, postclassify_results) {
      if (err) return callback(err);
      watson_response.postclassify = postclassify_results;
      //console.log('watsonquestion : Final Classify: ');
      //console.log(postclassify_results);

      if(postclassify_results.classes[0].confidence < classifierThresholdValue){
        watson_response.answers.push({
          "class" : postclassify_results.classes[0].class_name,
          "answer" : defaultAnswer,
          "answer4speech" : defaultAnswer4Speech,
          "confidence" : postclassify_results.classes[0].confidence
        });

      }else {
        for (var i=0;i<Math.min(output_num, postclassify_results.classes.length);i++) {
          //配列にPUSH
          var answer = _.find(answerstore_data, function(result) {
            return result.CLASS == postclassify_results.classes[i].class_name;
          });
          watson_response.answers.push({
            "class" : postclassify_results.classes[i].class_name,
            "answer" : (answer == undefined) ? "アンサーストアデータが見つかりませんでした。" : answer.TEXT,
            "answer4speech" : (answer == undefined) ? "" : answer.TEXT4SPEECH,
            "confidence" : postclassify_results.classes[i].confidence
          });
        };
      }
      //console.log('watsonquestion : watson_response: ');
      //console.log(watson_response.answers);
      callback(null, watson_response); //Sends a JSON response composed of a stringified version of data
    });
  }
}


/*****************************************************************************
Function executeSQL
*****************************************************************************/
// Call the pre-trained classifier with body.text
// Responses are json
function executeSQL(sql, callback) {
  ibmdb.open(constr, function (err,conn) {
    if (err) return console.log(err);
    console.log('executeSQL : sql');
    console.log(sql);

    conn.query(sql, function (err, sqldata) {
      callback(err, sqldata);
    });
    conn.close(function () {
      console.log('executeSQL : done');
    });
  });
}

/*****************************************************************************
 /api/v1/ipcheck API Definition
 *****************************************************************************/
// クライアントipアドレスのアクセス可否を回答を返すAPI
// Responses are json
app.post('/api/v1/ipCheck', function(req, res, next) {
  var originalIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  console.log("original_Ip:" + originalIp);
  var ip = originalIp.split(","); //取得したIPを,で分割する (xxx.xxx.xxx.xxx, yyy.yyy.yyy.yyy -> xxx.xxx.xxx.xxx)
  console.log("ip:" + ip[0]);
/* IPアドレスのチェックを行う場合の処理始まり
  var ipSplit = ip[0].split("."); //取得したIPを.で分割する
  var ipTmp = ""; //比較するIPをセットする変数
  //ipArrayで何番のオクテットまで指定されているかをチェックする
  var ipArraySplit= ipArray[0].split(".");
  if (ipArraySplit[0] != null && ipArraySplit[1] != null
      && ipArraySplit[2] != null && ipArraySplit[3] != null){
    //第1オクテットから第4オクテットまで指定された場合
    ipTmp =   ipSplit[0]+'.'+ipSplit[1] +'.'+ipSplit[2] +'.'+ipSplit[3];
  }
  else if  (ipArraySplit[0] != null && ipArraySplit[1] != null
      && ipArraySplit[2] != null && ipArraySplit[3] == null){
    //第1オクテットから第3オクテットまで指定された場合
    ipTmp =   ipSplit[0]+'.'+ipSplit[1] +'.'+ipSplit[2];
  }
  else if  (ipArraySplit[0] != null && ipArraySplit[1] != null
      && ipArraySplit[2] == null && ipArraySplit[3] == null){
    //第1オクテットから第2オクテットまで指定された場合
    ipTmp =   ipSplit[0]+'.'+ipSplit[1]
  }
  else if  (ipArraySplit[0] != null && ipArraySplit[1] == null
      && ipArraySplit[2] == null && ipArraySplit[3] == null){
    //第1オクテットまで指定された場合
    ipTmp =   ipSplit[0]
  }
  console.log("IP Adress(ipTmp) ：" + ipTmp );
  //  ipArrayに存在しない場合、不正アクセスとみなす
  if(ipArray.indexOf(ipTmp) < 0) {
    console.log('不正なipからのアクセス');
    var watson_response = {  // Response 用変数
      "isValidate" : "false",
      "ip" : originalIp
    };
    res.json(watson_response);
  }
  else{
    var watson_response = {  // Response 用変数
      "isValidate" : "true",
      "ip" : originalIp
    };
    res.json(watson_response);
  }
IPアドレスのチェックを行う場合の処理終わり */

/* IPアドレスのチェックを行わずに、IPアドレスの取得のみ行う場合の処理 */
  var watson_response = {  // Response 用変数
    "isValidate" : "true",
    "ip" : originalIp
  };
  res.json(watson_response);
});

/*****************************************************************************
/api/v1/question API Definition
*****************************************************************************/
// アプリに質問し、回答を返すAPI
// Responses are json
app.post('/api/v1/question', function(req, res, next) {
  watsonquestion(req.body, function(err, watson_response) {
    if (err) return next(err);
    //console.log(watson_response);
    try {
      res.json(watson_response);
    } catch (err) { return next(err); }

    // Input Q&A log to feedback DB (LOGS)
    for (var i=0; i<Math.min(watson_response.answers.length,watson_response.setting_multi_answer); i++) {
    	var j=i+1;
        var sql_feedback = "INSERT INTO LOGS (SESSION_ID, CLIENT_ID, CHAT_NUM, ANSWER_NUM, DATETIME, FEEDBACK, TEXT, CLASS, ANSWER, CONFIDENCE) VALUES('" +
                           watson_response.session_id + "','" +
                           watson_response.client_id + "','" +
                           watson_response.chat_num + "','" +
                           j +
                           "',(current timestamp), 0, '" +
                           watson_response.text + "','" +
                           watson_response.answers[i].class + "','" +
                           watson_response.answers[i].answer + "','" +
                           watson_response.answers[i].confidence + "')";
        executeSQL(sql_feedback, function(err, sqldata) {
          if (err) console.log(err);
        });
    }
  });
});

/*****************************************************************************
/api/v1/feedback API Definition
*****************************************************************************/
// フィードバックを登録するAPI
// Responses are json
app.post('/api/v1/feedback', function(req, res, next) {
  var watson_response = req.body;
  //var sql_feedback = "INSERT INTO LOGS (SESSION_ID, CLIENT_ID, DATETIME, FEEDBACK, TEXT, CLASS, ANSWER, CONFIDENCE, ANSWER_NUM) VALUES(0, '" +
  //watson_response.client_id + "',(current timestamp - current timezone)," + watson_response.feedback + ",'" + watson_response.text + "','" +
  //watson_response.class + "','" + watson_response.answer + "'," + watson_response.confidence + "," + watson_response.answer_num +")";

  //feedback popupを使用する場合、下記を使用する
  var sql_feedback = "INSERT INTO LOGS (SESSION_ID, CLIENT_ID, CHAT_NUM, ANSWER_NUM, DATETIME, FEEDBACK, TEXT, CLASS, ANSWER, CONFIDENCE) VALUES('" +
                     watson_response.session_id + "','" +
                     watson_response.client_id + "','" +
                     watson_response.chat_num + "','" +
                     watson_response.answer_num +
                     "',(current timestamp),'" +
                     watson_response.feedback + "','" +
                     watson_response.text + "','" +
                     watson_response.class + "','" +
                     watson_response.answer + "','" +
                     watson_response.confidence +  "')";

  executeSQL(sql_feedback, function(err, sqldata) {
    if (err) console.log(err);
    try {
      res.json(watson_response);
    } catch (err) { return next(err); }
  });

  if (watson_response.feedback == 9) {
    var sql_feedback = "INSERT INTO LOGS_COMMENT (SESSION_ID, CHAT_NUM, ANSWER_NUM, DATETIME, EXPECTED_ANSWER, COMMENT) VALUES('" +
                       watson_response.session_id + "','" +
                       watson_response.chat_num + "','" +
                       watson_response.answer_num +
                       "',(current timestamp),'" +
                       watson_response.expected_answer + "','" +
                       watson_response.comment + "')";

    executeSQL(sql_feedback, function(err, sqldata) {
      if (err) console.log(err);
      try {
        res.json(watson_response);
      } catch (err) { return next(err); }
    });
  }

});

/*****************************************************************************
/manage/api/v1/getFeedback API Definition
*****************************************************************************/
// フィードバックストアを作成するAPI
app.post('/manage/api/v1/createFeedbackstore', function(req, res, next) {

  //var sql_feedback = "CREATE TABLE LOGS (SESSION_ID INT, CLIENT_ID VARCHAR(10), DATETIME TIMESTAMP," +
  //"FEEDBACK INT, TEXT VARCHAR(1024), CLASS VARCHAR(255), ANSWER VARCHAR(4096), CONFIDENCE DECFLOAT, ANSWER_NUM INT);"

  //feedback popupを使用する場合、下記を使用する
  var sql_feedback = "CREATE TABLE LOGS (SESSION_ID CHAR(30), CLIENT_ID VARCHAR(80), CHAT_NUM INT, ANSWER_NUM INT, DATETIME TIMESTAMP," +
      "FEEDBACK INT, TEXT VARCHAR(1024), CLASS VARCHAR(255), ANSWER VARCHAR(4096), CONFIDENCE DECFLOAT);"

  executeSQL(sql_feedback, function(err, sqldata) {
    if (err) res.json("フィードバックストアは作成済みです")
    else  res.json("フィードバックストアが作成されました");
  });

  sql_feedback = "CREATE TABLE LOGS_COMMENT (SESSION_ID CHAR(30), CHAT_NUM INT, ANSWER_NUM INT, DATETIME TIMESTAMP," +
      "EXPECTED_ANSWER VARCHAR(255), COMMENT VARCHAR(4096));"

  executeSQL(sql_feedback, function(err, sqldata) {
    if (err) res.json("フィードバックストアとコメントストアは作成済みです")
    else  res.json("フィードバックストアとコメントストアが作成されました");
  });
});

/*****************************************************************************
/manage/api/v1/dspFeedback API Definition
*****************************************************************************/
// フィードバックストアのデータを表示するためのAPI
// 出力ファイルのパスを応答する。
app.post('/manage/api/v1/dspFeedback', function(req, res, next) {

  //var sql_feedback = "SELECT CLIENT_ID, (DATETIME + 9 hour) as DATETIME, FEEDBACK, TEXT, CLASS, ANSWER, CONFIDENCE, ANSWER_NUM FROM LOGS";
  //feedback popupを使用する場合、下記を使用する
  var sql_feedback = "SELECT A.ANSWER_NUM,(A.DATETIME + 9 hour) as DATETIME,A.FEEDBACK,A.TEXT,A.CLASS,A.ANSWER,round(A.CONFIDENCE,3) as CONFIDENCE, B.EXPECTED_ANSWER, B.COMMENT FROM LOGS AS A LEFT OUTER JOIN LOGS_COMMENT AS B ON A.SESSION_ID=B.SESSION_ID AND A.CHAT_NUM=B.CHAT_NUM AND A.ANSWER_NUM=B.ANSWER_NUM ";
  sql_feedback += (req.body.feedback_all == 'true') ?  " WHERE A.FEEDBACK != 65535" : " WHERE A.FEEDBACK != 0";
  sql_feedback += (req.body.feedback_good == 'true') ? '' : " AND A.FEEDBACK != 1";
  sql_feedback += (req.body.feedback_bad == 'true') ? '' : " AND A.FEEDBACK != -1";
  sql_feedback += (req.body.dtp_from == '') ? '' : " AND (A.DATETIME + 9 hour) >= '" + req.body.dtp_from +"'";
  sql_feedback += (req.body.dtp_to == '') ? '' : " AND (A.DATETIME + 9 hour) <= '" + req.body.dtp_to +"'";
  sql_feedback += " order by A.DATETIME";

  executeSQL(sql_feedback, function(err, sqldata) {
    if (err) return next(err);
    try {
      res.json(sqldata);
    } catch (err) { return next(err); }
  });
});

/*****************************************************************************
/manage/api/v1/downloadFeedback API Definition
*****************************************************************************/
// フィードバックストアのデータをダウンロードするためのAPI
app.post('/manage/api/v1/downloadFeedback', function(req, res, next) {

  var output_file = 'uploads/' + Math.random().toString(36).slice(-16) + '_output.csv';   // 出力ファイルのパス
  var writer = new csv.createCsvStreamWriter(fs.createWriteStream(output_file)); // CSV Writerの定義
  //var sql_feedback = "SELECT SESSION_ID, CLIENT_ID, (DATETIME + 9 hour) as DATETIME, FEEDBACK, TEXT, CLASS, ANSWER, CONFIDENCE, ANSWER_NUM FROM LOGS";
  //feedback popupを使用する場合、下記を使用する
  var sql_feedback = "SELECT A.SESSION_ID,A.CLIENT_ID,A.CHAT_NUM,A.ANSWER_NUM,(A.DATETIME + 9 hour) as DATETIME,A.FEEDBACK,A.TEXT,A.CLASS,A.ANSWER,A.CONFIDENCE, B.EXPECTED_ANSWER, B.COMMENT FROM LOGS AS A LEFT OUTER JOIN LOGS_COMMENT AS B ON A.SESSION_ID=B.SESSION_ID AND A.FEEDBACK=9 AND A.CHAT_NUM=B.CHAT_NUM AND A.ANSWER_NUM=B.ANSWER_NUM ";
  sql_feedback += (req.body.feedback_all == 'true') ?  " WHERE A.FEEDBACK != 65535" : " WHERE A.FEEDBACK != 0";
  sql_feedback += (req.body.feedback_good == 'true') ? '' : " AND A.FEEDBACK != 1";
  sql_feedback += (req.body.feedback_bad == 'true') ? '' : " AND A.FEEDBACK != -1";
  sql_feedback += (req.body.dtp_from == '') ? '' : " AND (A.DATETIME + 9 hour) >= '" + req.body.dtp_from +"'";
  sql_feedback += (req.body.dtp_to == '') ? '' : " AND (A.DATETIME + 9 hour) <= '" + req.body.dtp_to +"'";
  
  // ya-csv writer error handling
  writer.addListener('error', function (err) {
    console.log('/manage/api/v1/downloadFeedback Error : ' + output_file);
    return next(err);
  });

  executeSQL(sql_feedback, function(err, sqldata) {
    if (err) console.log(err);
    //console.log(sqldata);
    for (var i=0;i<sqldata.length;i++) {
      //var csvresult = [sqldata[i].CLIENT_ID, sqldata[i].DATETIME, sqldata[i].FEEDBACK, sqldata[i].TEXT, sqldata[i].CLASS, sqldata[i].ANSWER, sqldata[i].CONFIDENCE, sqldata[i].ANSWER_NUM];
      //feedback popupを使用する場合、下記を使用する
      var csvresult = [sqldata[i].SESSION_ID, sqldata[i].CLIENT_ID, sqldata[i].CHAT_NUM, sqldata[i].ANSWER_NUM, sqldata[i].DATETIME, sqldata[i].FEEDBACK, sqldata[i].TEXT, sqldata[i].CLASS, sqldata[i].ANSWER, sqldata[i].CONFIDENCE, sqldata[i].EXPECTED_ANSWER, sqldata[i].COMMENT];
      writer.writeRecord(csvresult);  // 出力ファイルに一行ずつCSVを追記
    }
    try {
      res.send('../' + output_file);
    } catch (err) { return next(err); }
    setTimeout(function(){
      fs.unlink(output_file, function (err) {  // テンポラリーで作成した出力ファイルを削除する。
        if (err) return next(err);
        console.log('/manage/api/v1/downloadFeedback successfully deleted ' + output_file);
      });
    }, 10000);
  });
});

/*****************************************************************************
/manage/api/v1/deleteFeedback API Definition
*****************************************************************************/
// フィードバックストアのデータを削除する。
app.post('/manage/api/v1/deleteFeedback', function(req, res, next) {

  if(req.body.dtp_from == '' & req.body.dtp_to == '')  res.json("日付の指定は必須です。");
  else {
    var sql_feedback = "DELETE FROM LOGS_COMMENT AS B WHERE (B.SESSION_ID, B.CHAT_NUM, B.ANSWER_NUM) IN (SELECT A.SESSION_ID, A.CHAT_NUM, A.ANSWER_NUM FROM LOGS AS A";

    sql_feedback += (req.body.feedback_all == 'true') ?  " WHERE A.FEEDBACK != 65535" : " WHERE A.FEEDBACK != 0";
    sql_feedback += (req.body.feedback_good == 'true') ? '' : " AND A.FEEDBACK != 1";
    sql_feedback += (req.body.feedback_bad == 'true') ? '' : " AND A.FEEDBACK != -1";
    sql_feedback += " AND A.FEEDBACK = 9";
    sql_feedback += (req.body.dtp_from == '') ? '' : " AND (A.DATETIME + 9 hour) >= '" + req.body.dtp_from +"'";
    sql_feedback += (req.body.dtp_to == '') ? '' : " AND (A.DATETIME + 9 hour) <= '" + req.body.dtp_to +"'";
    sql_feedback += ")";

    executeSQL(sql_feedback, function(err, sqldata) {
      if (err) return next(err);
    });

    var sql_feedback = "DELETE FROM LOGS ";

    sql_feedback += (req.body.feedback_all == 'true') ?  " WHERE FEEDBACK != 65535" : " WHERE FEEDBACK != 0";
    sql_feedback += (req.body.feedback_good == 'true') ? '' : " AND FEEDBACK != 1";
    sql_feedback += (req.body.feedback_bad == 'true') ? '' : " AND FEEDBACK != -1";
    sql_feedback += (req.body.dtp_from == '') ? '' : " AND (DATETIME + 9 hour) >= '" + req.body.dtp_from +"'";
    sql_feedback += (req.body.dtp_to == '') ? '' : " AND (DATETIME + 9 hour) <= '" + req.body.dtp_to +"'";

    executeSQL(sql_feedback, function(err, sqldata) {
      if (err) return next(err);
      else  res.json("フィードバックストアのデータが削除されました");
    });
  };
});

/*****************************************************************************
/manage/api/v1/downloadNlctest API Definition
*****************************************************************************/
// NLC のテスト結果をダウンロードする。
app.post('/manage/api/v1/downloadNlctest', upload.single('csv'), function (req, res, next) {

  var select_classifier_id = req.body.select_classifier_id;  // NLC クラシファイを指定
  var reqPath = req.file.path;  // 入力ファイルのパス
  var output_file = reqPath + '_output.csv';  // 出力ファイルのパス
  var reader = csv.createCsvFileReader(reqPath, {});  // CSV Readerの定義
  var i = 0;
  var j = 0;
  var writer = new csv.createCsvStreamWriter(fs.createWriteStream(output_file));  // CSV Writerの定義

  // ya-csv writer error handling
  writer.addListener('error', function (err) {
    console.log('/manage/api/v1/downloadNlctest Error : ' + output_file);
    return next(err);
  });

  // ya-csv reader error handling
  reader.addListener('error', function (err) {
    console.log('/manage/api/v1/downloadNlctest Error : ' + req.file.path);
    return next(err);
  });

  reader.addListener('data', function (data) {
    var test_classify_params = {
      "classifier" : select_classifier_id, // preclassify_class
      "text" : data[0]
    };
    nlClassifier.classify(test_classify_params, function(err, test_classify_results) {
      if (err) return next(err);
      var csvresult;
      if (test_classify_results.classes.length > 1) {
        csvresult = [j, data[0], data[1],  test_classify_results.classes[0].class_name,"" , test_classify_results.classes[0].confidence,test_classify_results.classes[1].class_name,"" , test_classify_results.classes[1].confidence];
      } else {
        csvresult = [j, data[0], data[1],  test_classify_results.classes[0].class_name,"" , test_classify_results.classes[0].confidence];
      }
      writer.writeRecord(csvresult);  // 出力ファイルに一行ずつCSVを追記
      j++;
      if (i == j) { // 非同期処理が全て完了したら
        setTimeout(function(){
          fs.unlink(reqPath, function (err) { // テンポラリーで作成した入力ファイルを削除する。
            if (err) return next(err);
            console.log('/manage/api/v1/downloadNlctest successfully deleted ' + reqPath);
          });
          try {
            res.send('../' + output_file);
          } catch (err) { return next(err); }
          setTimeout(function(){
            fs.unlink(output_file, function (err) { // テンポラリーで作成した出力ファイルを削除する。
              if (err) return next(err);
              console.log('/manage/api/v1/downloadNlctest successfully deleted ' + output_file);
            });
          }, 1000);
        }, 1000);
      }
    });
    i++;
  });
});

/*****************************************************************************
/manage/api/v1/dspNlctest API Definition
*****************************************************************************/
// NLC のテスト結果を表示する。
app.post('/manage/api/v1/dspNlctest', upload.single('csv'), function (req, res, next) {
  var select_classifier_id = req.body.select_classifier_id;  // NLC クラシファイを指定
  var reqPath = req.file.path;  // 入力ファイルのパス
  var output_file = reqPath + '_output.csv';  // 出力ファイルのパス
  var reader = csv.createCsvFileReader(reqPath, {});  // CSV Readerの定義
  var i = 0;
  var j = 0;
  var jsonresult = [];  // JSONの出力結果を作成

  // ya-csv reader error handling
  reader.addListener('error', function (err) {
    console.log('/manage/api/v1/dspNlctest Error : ' + req.file.path);
    return next(err);
  });

  reader.addListener('data', function (data) {
    var test_classify_params = {
      "classifier" : select_classifier_id, // preclassify_class
      "text" : data[0]
    };
    nlClassifier.classify(test_classify_params, function(err, test_classify_results) {
      if (err) return next(err);
      jsonresult.push({
        "num": j,
        "question": data[0],
        "desired class": data[1],
        "returened class": test_classify_results.classes[0].class_name,
        "returned text": "" ,
        "returned confidence": test_classify_results.classes[0].confidence
      });
      j++;
      if (i == j) { // 非同期処理が全て完了したら
        setTimeout(function(){
          fs.unlink(reqPath, function (err) { // テンポラリーで作成した入力ファイルを削除する。
            if (err) return next(err);
            console.log('/manage/api/v1/dspNlctest successfully deleted ' + req.file.path);
          });
          try {
            res.json(jsonresult);
          } catch (err) { return next(err); }
        }, 1000);
      }
    });
    i++;
  });
});

/*****************************************************************************
/manage/api/v1/createAnswerstore API Definition
*****************************************************************************/
// アンサーストアを作成するAPI
app.post('/manage/api/v1/createAnswerstore', function(req, res, next) {

  var sql_delete = 'DROP TABLE ' + answerstore_name;
  var sql_create = 'CREATE TABLE ' + answerstore_name + '(CLASS VARCHAR(256), TITLE VARCHAR(1000), TEXT VARCHAR(30000), TEXT4SPEECH VARCHAR(30000))';

  executeSQL(sql_delete, function(err, sqldata) {
    if (err) console.log(err);
    executeSQL(sql_create, function(err2, sqldata) {
      if (err2) return next(err2);
      else res.json("アンサーストアは正常に作成されました"); //Sends a JSON response composed of a stringified version of data
    });
  });
});

/*****************************************************************************
/manage/api/v1/uploadAnswerstore API Definition
*****************************************************************************/
// アンサーストアのデータを登録するAPI
app.post('/manage/api/v1/uploadAnswerstore', upload.single('csv'), function(req, res, next) {
  var reqPath = req.file.path;  // 入力ファイルのパス
  var reader = csv.createCsvFileReader(req.file.path, {});  // CSV Readerの定義
  var sqlError;
  var i = 0;
  var j = 0;

  var conn = ibmdb.openSync(constr);
  console.log("start connecting...");
  //begin transaction
  conn.beginTransaction(function(err){
    if (err) {
      next(err);
      return conn.closeSync();
    }
    // ya-csv reader error handling
    reader.addListener('error', function (err) {
      console.log('/manage/api/v1/uploadAnswerstore Error : ' + req.file.path);
      return next(err);
    });

    reader.addListener('data', function (data) { //csvファイルを1行ごとに読み込み
      try {
        var result = conn.querySync("INSERT INTO " + answerstore_name + "(CLASS,TITLE,TEXT,TEXT4SPEECH) VALUES('" + data[0] + "','" + data[1] + "','" + data[2] + "','" + data[3] + "')");
      } catch (e) {
        sqlError = e;
        console.log(sqlError.message);
      }
      //commit
      conn.commitTransaction(function (err) {
        if (err) {
          next(err);
          return conn.closeSync();
        }
        j++;
        if (i == j) { // 非同期処理が全て完了したら
        	conn.closeSync(); //完了後にcloseSync
            setTimeout(function(){
            fs.unlink(reqPath, function (err) { // テンポラリーで作成した入力ファイルを削除する。
              if (err) return next(err);
              console.log('/manage/api/v1/uploadAnswerstore successfully deleted ' + reqPath);
            });
            answerstore_getlist()
            if (sqlError) next(sqlError);
            else res.json("アンサーストアデータを登録しました");
          }, 1000);
        }
      });
      i++;
    });
  });
});

/*****************************************************************************
/manage/api/v1/dspAnswerstore API Definition
*****************************************************************************/
// アンサーストアのデータを表示するAPI
app.post('/manage/api/v1/dspAnswerstore', function(req, res, next) {

  var sql = 'SELECT "CLASS","TITLE","TEXT","TEXT4SPEECH" FROM '+answerstore_name;

  executeSQL(sql, function(err, sqldata) {
    if (err) return next(err);
    try {
      res.json(sqldata);
    } catch (err) { return next(err); }
  });
});
// アンサーストアのデータを表示するAPI(ユーザー向けPopup用)
app.post('/api/v1/dspAnswerstore', function(req, res, next) {

  var sql = "SELECT CLASS,TITLE,TEXT FROM "+answerstore_name+" WHERE CLASS NOT LIKE 'default%' ";

  executeSQL(sql, function(err, sqldata) {
    if (err) return next(err);
    try {
      res.json(sqldata);
    } catch (err) { return next(err); }
  });
});

/*****************************************************************************
/manage/api/v1/downloadQAtest API Definition
*****************************************************************************/
// QAテストの結果をダウンロードするAPI
app.post('/manage/api/v1/downloadQAtest', upload.single('csv'), function (req, res, next) {
  var reqPath = req.file.path;  // 入力ファイルのパス
  var output_file = reqPath + '_output.csv';  // 出力ファイルのパス
  var reader = csv.createCsvFileReader(reqPath, {});  // CSV Readerの定義
  var i = 0;
  var j = 0;
  var writer = new csv.createCsvStreamWriter(fs.createWriteStream(output_file)); // CSV Writerの定義

  // ya-csv writer error handling
  writer.addListener('error', function (err) {
    console.log('/manage/api/v1/downloadQAtest Error : ' + output_file);
    return next(err);
  });

  // ya-csv reader error handling
  reader.addListener('error', function (err) {
    console.log('/manage/api/v1/downloadQAtest Error : ' + req.file.path);
    return next(err);
  });

  reader.addListener('data', function (data) {
    var param = {
      "output_num" : 2,
      "session_id" : 0,
      "client_id" : 'qa_test',
      "chat_num" : 0,
      "setting_multi_answer" : 1,
      "text" : data[0]
    }

    watsonquestion(param, function(err, watson_response) {
      if (err) return next(err);
      var csvresult;
      if(watson_response.answers.length > 1) {
        csvresult = [j, data[0], data[1],  watson_response.answers[0].class,watson_response.answers[0].answer , watson_response.answers[0].confidence, watson_response.answers[1].class,watson_response.answers[1].answer , watson_response.answers[1].confidence];
      } else {
        csvresult = [j, data[0], data[1],  watson_response.answers[0].class,watson_response.answers[0].answer , watson_response.answers[0].confidence];
      }
      //console.log(csvresult);
      writer.writeRecord(csvresult);  // 出力ファイルに一行ずつCSVを追記
      j++;
      if (i == j) { // 非同期処理が全て完了したら
        setTimeout(function(){
          fs.unlink(reqPath, function (err) { // テンポラリーで作成した入力ファイルを削除する。
            if (err) return next(err);
            console.log('/manage/api/v1/downloadQAtest successfully deleted ' + reqPath);
          });
          //console.log('../' + output_file);
          try {
            res.send('../' + output_file);
          } catch (err) { return next(err); }
          setTimeout(function(){
            fs.unlink(output_file, function (err) { // テンポラリーで作成した出力ファイルを削除する。
              if (err) return next(err);
              console.log('/manage/api/v1/downloadQAtest successfully deleted ' + output_file);
            });
          }, 1000);
        }, 1000);
      }
    });
    i++;
  });
});

/*****************************************************************************
/manage/api/v1/dspQAtest API Definition
*****************************************************************************/
// QAテストの結果を表示するAPI
app.post('/manage/api/v1/dspQAtest', upload.single('csv'), function (req, res, next) {
  var reqPath = req.file.path;  // 入力ファイルのパス
  var output_file = reqPath + '_output.csv';  // 出力ファイルのパス
  var reader = csv.createCsvFileReader(reqPath, {});  // CSV Readerの定義
  var i = 0;
  var j = 0;
  var jsonresult = [];  // JSONの出力結果を作成

  // ya-csv reader error handling
  reader.addListener('error', function (err) {
    console.log('/manage/api/v1/dspQAtest Error : ' + req.file.path);
    return next(err);
  });

  // ya-csv reader listener setting
  reader.addListener('data', function (data) {
    var param = {
      "output_num" : 1,
      "session_id" : 0,
      "client_id" : 'qa_test',
      "chat_num" : 0,
      "setting_multi_answer" : 1,
      "text" : data[0]
    }

    watsonquestion(param, function(err, watson_response) {
      if (err) return next(err);
      jsonresult.push({
        "num": j,
        "question": data[0],
        "desired class": data[1],
        "returned class" : watson_response.answers[0].class,
        "answer" : watson_response.answers[0].answer,
        "confidence" : watson_response.answers[0].confidence
      });

      j++;
      if (i == j) { // 非同期処理が全て完了したら
        setTimeout(function(){
          fs.unlink(reqPath, function (err) { // テンポラリーで作成した入力ファイルを削除する。
            if (err) return next(err);
            console.log('/manage/api/v1/dspQAtest successfully deleted ' + req.file.path);
          });
          try {
            res.json(jsonresult);
          } catch (err) { return next(err); }
        }, 1000);
      }
    });
    i++;
  });
});


/*****************************************************************************
/manage/api/v1/listNlc API Definition
*****************************************************************************/
// NLC クラシファイのリストを表示
app.post('/manage/api/v1/listNlc', function (req, res, next) {
  classifiers_getlist(function(err){
    if (err) return next(err);
    console.log('/manage/api/v1/listNlc api : classifiers')
    console.log(classifiers);
    try {
      res.json(classifiers);
    } catch (err) { return next(err); }

  });
});

/*****************************************************************************
/manage/api/v1/listNlcstatus API Definition
*****************************************************************************/
// NLC クラシファイのリストをステータスつきで表示
app.post('/manage/api/v1/listNlcstatus', function (req, res, next) {
  classifiers_status = [];
  classifiers_getlist(function(err){
    if (err) return next(err);
    var statusCount = 0;
    for(var i=0;i<classifiers.length;i++){
      var params={
        classifier_id : classifiers[i].classifier_id
      };
      nlClassifier.status(params, function(err,result){
        if(err) return next(err);
        classifiers_status.push(result);
        statusCount++;
        if(statusCount==classifiers.length){
          console.log('/manage/api/v1/listNlcstatus api : classifiers_status')
          console.log(classifiers_status);
          try {
            res.json(classifiers_status);
          } catch (err) { return next(err); }
        }
      });
    }
  });
});

/*****************************************************************************
/manage/api/v1/createNlc API Definition
*****************************************************************************/
// NLC クラシファイの作成
app.post('/manage/api/v1/createNlc', upload.single('csv'), function (req, res, next) {
  var params = {
    language: req.body.selectLanguage,
    name: req.body.classifierName,
    training_data: fs.createReadStream(req.file.path)
  };
  nlClassifier.create(params, function(err, result){
    if(err) return next(err);
    console.log('/manage/api/v1/createNlc : result')
    console.log(result);
    setTimeout(function(){
      fs.unlink(req.file.path, function (err) { // テンポラリーで作成した入力ファイルを削除する。
        if (err) return next(err);
        else console.log('/manage/api/v1/createNlc successfully deleted ' + req.file.path);
      });
      res.json("NLC "+req.body.classifierName+"クラスを作成しました");
    }, 1000);
  });
});

/*****************************************************************************
/manage/api/v1/setClassifierThreshold API Definition
*****************************************************************************/
// 確信度のしきい値をセットするAPI
app.post('/manage/api/v1/setClassifierThreshold', function (req, res, next) {
  classifierThresholdValue = req.body.classifierThresholdValue;
  console.log("しきい値を"+classifierThresholdValue+"にセットしました");
  res.json("しきい値を"+classifierThresholdValue+"にセットしました");
  settingJson.classifierThresholdValue = classifierThresholdValue;
  //console.log(settingJson);
  fs.writeFile('./classifierSettings.json', JSON.stringify(settingJson) ,function(err){
    if(err) console.log(err);
  });
});

/*****************************************************************************
/manage/api/v1/showClassifierThreshold API Definition
*****************************************************************************/
// 確信度のしきい値を取得するAPI
app.post('/manage/api/v1/showClassifierThreshold', function (req, res, next) {
  try {
    res.json(classifierThresholdValue);
  } catch (err) { return next(err); }
});

/*****************************************************************************
/manage/api/v1/deleteNlc API Definition
*****************************************************************************/
// NLC クラシファイを削除するAPI
app.post('/manage/api/v1/deleteNlc', function(req, res, next){
  var params = {
    classifier_id : req.body.classifier_id
  };
  nlClassifier.remove(params,function(err, result){
    if (err) return next(err);
    console.log('/manage/api/v1/deleteNlc : result')
    console.log(result);
    try {
      res.json(result);
    } catch (err) { return next(err); }
  });
});

/*****************************************************************************
/api/synthesize API Definition
*****************************************************************************/
// Text to Speech用
// For local development, replace username and password
var textToSpeech = watson.text_to_speech({
  version: 'v1',
  username: '<username>',
  password: '<password>'
});

app.get('/api/synthesize', function(req, res, next) {
  var transcript = textToSpeech.synthesize(req.query);
  transcript.on('response', function(response) {
    if (req.query.download) {
      response.headers['content-disposition'] = 'attachment; filename=transcript.ogg';
    }
  });
  transcript.on('error', function(error) {
    next(error);
  });
  transcript.pipe(res);
});


// catch 404 and forward to error handler
app.use(function(req, res, next) {
  var err = new Error('Not Found');
  err.code = 404;
  err.message = 'Not Found';
  next(err);
});

// error handler
app.use(function(err, req, res, next) {
  var error = {
    code: err.code || 500,
    error: err.message || err.error
  };
  console.log('error:', error);
  res.status(error.code).json(error);
});


// start server on the specified port and binding host
app.listen(appEnv.port, appEnv.bind, function() {
  // print a message when the server starts listening
  console.log("server starting on " + appEnv.url);
});
