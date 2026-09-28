#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"

#include <ESP32Servo.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

// ============================================================
//  CREDENTIALS
// ============================================================
#define WIFI_SSID       "krish"
#define WIFI_PASSWORD   "okkrishfine"
#define API_KEY         "AIzaSyDUs4meTrtJKgNLy-YvRiufFX5NjymB-SM"
#define DATABASE_URL    "krux-ee1df-default-rtdb.firebaseio.com"
#define BIN_ID          "KRUX_BIN_001"

// ============================================================
//  FIREBASE OBJECTS
// ============================================================
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

// ============================================================
//  OLED
// ============================================================
#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

// ============================================================
//  HARDWARE PINS  (match YOUR wiring)
// ============================================================
const int PIN_SENSOR_ADC  = 34;
const int PIN_INDUCTIVE   = 25;
const int PIN_PAN_SERVO_1 = 19;
const int PIN_PAN_SERVO_2 = 18;
const int PIN_TILT_SERVO  = 23;
const int PIN_IR_SENSOR   = 27;
const int PIN_LASER       = 5;

Servo panServo1;
Servo panServo2;
Servo tiltServo;

// ============================================================
//  ANGLES
// ============================================================
const int TILT_FLAT   = 90;
const int TILT_DROP   = 150;
const int ANGLE_HOME  = 90;
const int ANGLE_HOME_2= 0;

// Material → Servo angle mapping
int getAngleForMaterial(String mat) {
  if (mat == "PET")  return 0;
  if (mat == "HDPE") return 60;
  if (mat == "PP")   return 120;
  if (mat == "LDPE") return 150;
  if (mat == "PVC")  return 180;
  if (mat == "PS")   return 200;   // > 180 = servo2
  if (mat == "METAL") return 250;  // > 180 = servo2
  return 90; // default = home
}

// ============================================================
//  TIMING & STATE
// ============================================================
unsigned long lastPrintTime     = 0;
unsigned long lastFirebaseCheck = 0;
bool firebaseReady              = false;
bool appConnected               = false;

// Track last processed scan command to avoid re-processing
unsigned long lastProcessedTimestamp = 0;

// ============================================================
//  OLED HELPERS
// ============================================================
void oledMsg(String line1, String line2 = "", String line3 = "") {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(WHITE);
  display.setCursor(0, 0);
  display.println(line1);
  if (line2.length() > 0) { display.setCursor(0, 20); display.println(line2); }
  if (line3.length() > 0) { display.setCursor(0, 40); display.println(line3); }
  display.display();
}

void oledBig(String line1, String line2 = "") {
  display.clearDisplay();
  display.setTextSize(2);
  display.setTextColor(WHITE);
  display.setCursor(0, 10);
  display.println(line1);
  if (line2.length() > 0) { display.setCursor(0, 35); display.println(line2); }
  display.display();
}

void updateOLED(String material, int coins) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(WHITE);
  display.setCursor(0, 0);
  display.println("ECO-SORT PRO V5.0");
  display.drawLine(0, 10, 128, 10, WHITE);

  display.setCursor(0, 15);
  display.print("Material: ");
  display.setTextSize(2);
  display.setCursor(0, 25);
  display.println(material);
  
  display.setTextSize(1);
  display.setCursor(0, 50);
  display.print("Coins: +");
  display.print(coins);
  display.print(" KRUX");
  display.display();
}

// ============================================================
//  SETUP
// ============================================================
void setup() {
  Serial.begin(115200);
  Serial.println("\n\n========== KRUX BIN BOOTING ==========");

  pinMode(PIN_LASER, OUTPUT);
  digitalWrite(PIN_LASER, LOW);
  pinMode(PIN_IR_SENSOR, INPUT);
  pinMode(PIN_INDUCTIVE, INPUT_PULLDOWN);

  // OLED
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("ERROR: OLED init failed!");
  }
  display.setTextColor(WHITE);
  oledBig("BOOTING..");

  // WIFI
  Serial.print("Connecting to WiFi: ");
  Serial.println(WIFI_SSID);
  oledMsg("WiFi connecting..", WIFI_SSID);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi CONNECTED!");
    oledMsg("WiFi CONNECTED!", WiFi.localIP().toString());
    delay(1000);
  } else {
    Serial.println("\nWiFi FAILED!");
    oledBig("WiFi", "FAILED!");
  }

  // FIREBASE
  config.api_key      = API_KEY;
  config.database_url = DATABASE_URL;

  if (Firebase.signUp(&config, &auth, "", "")) {
    Serial.println("Firebase Auth: OK (anonymous)");
  } else {
    Serial.print("Firebase Auth ERROR: ");
    Serial.println(config.signer.signupError.message.c_str());
  }

  config.token_status_callback = tokenStatusCallback;
  fbdo.setBSSLBufferSize(2048, 1024);
  fbdo.setResponseSize(1024);

  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  // SERVOS (init and detach)
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);

  panServo1.setPeriodHertz(50);
  panServo1.attach(PIN_PAN_SERVO_1, 500, 2400);
  panServo1.write(ANGLE_HOME);
  delay(500);
  panServo1.detach();

  panServo2.setPeriodHertz(50);
  panServo2.attach(PIN_PAN_SERVO_2, 500, 2400);
  panServo2.write(ANGLE_HOME_2);
  delay(500);
  panServo2.detach();

  tiltServo.setPeriodHertz(50);
  tiltServo.attach(PIN_TILT_SERVO, 500, 2400);
  tiltServo.write(TILT_FLAT);
  delay(500);
  tiltServo.detach();

  Serial.println("========== SETUP COMPLETE ==========");
  oledMsg("READY - WAITING", "for app to", "connect...");
}

// ============================================================
//  ACTUATE SERVOS based on material
// ============================================================
void actuateDrop(String material) {
  int targetAngle = getAngleForMaterial(material);
  
  Serial.print(">> ACTUATING for: ");
  Serial.print(material);
  Serial.print(" -> angle: ");
  Serial.println(targetAngle);

  oledBig(material, "SORTING...");

  if (targetAngle <= 180) {
    panServo1.attach(PIN_PAN_SERVO_1, 500, 2400);
    panServo1.write(targetAngle);
    delay(1000);
    panServo1.detach();

    tiltServo.attach(PIN_TILT_SERVO, 500, 2400);
    tiltServo.write(TILT_DROP);
    delay(1000);
    tiltServo.write(TILT_FLAT);
    delay(600);
    tiltServo.detach();

    panServo1.attach(PIN_PAN_SERVO_1, 500, 2400);
    panServo1.write(ANGLE_HOME);
    delay(800);
    panServo1.detach();
  } else {
    int servo2Angle = targetAngle - 180;
    panServo2.attach(PIN_PAN_SERVO_2, 500, 2400);
    panServo2.write(servo2Angle);
    delay(1000);
    panServo2.detach();

    tiltServo.attach(PIN_TILT_SERVO, 500, 2400);
    tiltServo.write(TILT_DROP);
    delay(1000);
    tiltServo.write(TILT_FLAT);
    delay(600);
    tiltServo.detach();

    panServo2.attach(PIN_PAN_SERVO_2, 500, 2400);
    panServo2.write(ANGLE_HOME_2);
    delay(800);
    panServo2.detach();
  }

  oledBig("DROP", "DONE!");
  delay(1000);
}

// ============================================================
//  NOTIFY APP: Drop confirmed
// ============================================================
void notifyAppDropCompleted(String material, int coins) {
  if (!Firebase.ready()) return;
  
  String path = "/drop_events/" + String(BIN_ID);
  FirebaseJson json;
  json.set("status", "confirmed");
  json.set("material", material);
  json.set("krux_earned", coins);
  json.set("timestamp", (int)(millis() / 1000));
  
  if (Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json)) {
    Serial.println(">> Firebase: Drop confirmed sent to app!");
  } else {
    Serial.print(">> Firebase ERROR: ");
    Serial.println(fbdo.errorReason());
  }
}

// ============================================================
//  MAIN LOOP
// ============================================================
void loop() {

  // ---- Periodic heartbeat (every 2 seconds) ----
  if (millis() - lastPrintTime > 2000) {
    Serial.print("Connected: ");
    Serial.print(appConnected ? "YES" : "no");
    Serial.print(" | Firebase: ");
    Serial.println(Firebase.ready() ? "READY" : "not ready");
    
    if (!appConnected) {
      oledMsg("WAITING FOR APP", "Scan QR to", "connect...");
    }
    lastPrintTime = millis();
  }

  // ============================================================
  //  FIREBASE POLLING — every 3 seconds
  // ============================================================
  if (millis() > 5000 && millis() - lastFirebaseCheck > 3000) {
    lastFirebaseCheck = millis();

    if (!Firebase.ready()) {
      Serial.println(">> Firebase NOT ready yet...");
      return;
    }

    if (!firebaseReady) {
      firebaseReady = true;
      Serial.println(">> Firebase is READY.");
    }

    // ─── STEP 1: HANDSHAKE ───
    // Check if app is requesting connection
    String statusPath = "/bins/" + String(BIN_ID) + "/status";

    if (Firebase.RTDB.getString(&fbdo, statusPath.c_str())) {
      String status = fbdo.stringData();

      if (status == "requesting_connection") {
        Serial.println("\n=============================================");
        Serial.println("  >>> APP CONNECTED TO BIN SUCCESSFULLY! <<<");
        Serial.println("=============================================\n");

        oledBig("APP", "CONNECTED!");

        // Reply 'connected' so the app unlocks its camera
        Firebase.RTDB.setString(&fbdo, statusPath.c_str(), "connected");
        appConnected = true;
        delay(2000);
      }
    }

    // ─── STEP 2: CHECK FOR SCAN COMMANDS FROM APP ───
    // After the app classifies plastic via ML, it writes to /scan_commands/BIN_ID
    if (appConnected) {
      String cmdPath = "/scan_commands/" + String(BIN_ID);

      if (Firebase.RTDB.getJSON(&fbdo, cmdPath.c_str())) {
        FirebaseJson json;
        json.setJsonData(fbdo.stringData());

        FirebaseJsonData statusData, materialData, coinsData, timestampData;
        json.get(statusData, "status");
        json.get(materialData, "material");
        json.get(coinsData, "coins");
        json.get(timestampData, "timestamp");

        String cmdStatus = statusData.stringValue;
        String material  = materialData.stringValue;
        int coins        = coinsData.intValue;
        unsigned long cmdTimestamp = timestampData.intValue;

        // Only process NEW commands (status = "pending_drop" and not already processed)
        if (cmdStatus == "pending_drop" && cmdTimestamp != lastProcessedTimestamp) {
          lastProcessedTimestamp = cmdTimestamp;

          Serial.println("\n>> ============================");
          Serial.print(">> APP CLASSIFIED: ");
          Serial.println(material);
          Serial.print(">> COINS: ");
          Serial.println(coins);
          Serial.println(">> ============================\n");

          // Show on OLED what the app detected
          updateOLED(material, coins);
          delay(2000);

          // Mark command as 'actuating' so app knows we received it
          Firebase.RTDB.setString(&fbdo, (cmdPath + "/status").c_str(), "actuating");

          // ACTUATE THE SERVOS!
          actuateDrop(material);

          // Mark command as 'dropped'
          Firebase.RTDB.setString(&fbdo, (cmdPath + "/status").c_str(), "dropped");

          // Send drop confirmation to the app
          notifyAppDropCompleted(material, coins);

          Serial.println(">> FULL CYCLE COMPLETE! Waiting for next scan...\n");
          oledMsg("DROP COMPLETE!", material, "+" + String(coins) + " KRUX");
        }
      }
    }
  }
}