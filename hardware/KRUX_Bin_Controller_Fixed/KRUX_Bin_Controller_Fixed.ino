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
#define DATABASE_URL    "krux-ee1df-default-rtdb.firebaseio.com" // DO NOT add https:// here!
#define BIN_ID          "KRUX_BIN_001"

// ============================================================
//  FIREBASE OBJECTS
// ============================================================
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;
bool firebaseReady = false;
unsigned long lastFirebaseCheck = 0;
bool appConnected = false;
unsigned long lastPrintTime = 0;

// ============================================================
//  HARDWARE PINS
// ============================================================
#define PIN_SENSOR_ADC  34
#define PIN_INDUCTIVE   35
#define PIN_LASER       32
#define PIN_IR_SENSOR   25
#define PIN_PAN_SERVO_1 14
#define PIN_PAN_SERVO_2 27
#define PIN_TILT_SERVO  26

// ============================================================
//  SERVO ANGLES & THRESHOLDS
// ============================================================
const int ANGLE_HOME    = 0;
const int ANGLE_HOME_2  = 0;
const int TILT_FLAT     = 100;
const int TILT_DROP     = 30;

const int ANGLE_PET     = 120;
const int ANGLE_HDPE    = 60;
const int ANGLE_PP      = 230;
const int ANGLE_METAL   = 290;

const int THRESH_NO_PAPER = 100;
const int THRESH_HDPE_MAX = 500;
const int THRESH_PP_MAX   = 2000;

Servo panServo1;
Servo panServo2;
Servo tiltServo;

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET    -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// ============================================================
//  OLED HELPERS
// ============================================================
void oledMsg(String line1, String line2, String line3 = "") {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(WHITE);
  display.setCursor(0, 0);
  display.println(line1);
  display.println(line2);
  display.println(line3);
  display.display();
}

void oledBig(String top, String bottom) {
  display.clearDisplay();
  display.setTextColor(WHITE);
  display.setCursor(0, 0);
  display.setTextSize(1);
  display.println(top);
  display.drawLine(0, 10, 128, 10, WHITE);
  display.setCursor(0, 20);
  display.setTextSize(2);
  display.println(bottom);
  display.display();
}

void updateOLED(String material, String footprint, int angle) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("ECO-SORT PRO V5.0");
  display.drawLine(0, 10, 128, 10, WHITE);

  if (material == "no paper") {
    display.setTextSize(2);
    display.setCursor(0, 30);
    display.println("No plastic");
  } else {
    display.setTextSize(1);
    display.setCursor(0, 20);
    display.print("TYPE: ");
    display.setTextSize(2);
    display.println(material);
    display.setTextSize(1);
    display.setCursor(0, 45);
    display.print("CO2: ");
    display.println(footprint);
    display.setCursor(0, 55);
    display.print("Ang: ");
    display.print(angle);
    display.print(" deg");
  }
  display.display();
}

// ============================================================
//  SETUP
// ============================================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  
  if(!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println(F("SSD1306 allocation failed"));
  }
  oledMsg("BOOTING...", "Connecting to WiFi");

  pinMode(PIN_SENSOR_ADC, INPUT);
  pinMode(PIN_INDUCTIVE, INPUT_PULLDOWN);
  pinMode(PIN_LASER, OUTPUT);
  pinMode(PIN_IR_SENSOR, INPUT);

  digitalWrite(PIN_LASER, LOW);

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi connected.");
  oledMsg("WIFI CONNECTED", "IP:", WiFi.localIP().toString());

  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  config.token_status_callback = tokenStatusCallback;

  // Sign up anonymously (Required to prevent 400 Bad Request)
  if (Firebase.signUp(&config, &auth, "", "")) {
    Serial.println(">> Firebase Auth: Anonymous Sign Up OK");
  } else {
    Serial.print(">> Firebase Auth ERROR: ");
    Serial.println(config.signer.signupError.message.c_str());
  }

  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);

  // Initialize Servos
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

  analogSetAttenuation(ADC_11db);

  Serial.println("========== SETUP COMPLETE ==========");
  oledMsg("READY - WAITING", "for app to", "connect...");
}

// ============================================================
//  SENSOR READING
// ============================================================
int getSmoothedReading() {
  digitalWrite(PIN_LASER, HIGH);
  delayMicroseconds(500);
  int sum = 0;
  for (int i = 0; i < 10; i++) {
    sum += analogRead(PIN_SENSOR_ADC);
  }
  digitalWrite(PIN_LASER, LOW);
  return sum / 10;
}

// ============================================================
//  NOTIFY APP AFTER DROP
// ============================================================
void notifyAppDropCompleted(int coins) {
  if (Firebase.ready()) {
    String path = "/drop_events/" + String(BIN_ID);
    FirebaseJson json;
    json.set("status", "confirmed");
    json.set("krux_earned", coins);
    if (Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json)) {
      Serial.println(">> Firebase: Drop event sent to app!");
    } else {
      Serial.print(">> Firebase drop event ERROR: ");
      Serial.println(fbdo.errorReason());
    }
  }
}

// ============================================================
//  MAIN LOOP
// ============================================================
void loop() {
  int sensorValue = getSmoothedReading();
  int irState     = digitalRead(PIN_IR_SENSOR);
  bool metalDetected = (digitalRead(PIN_INDUCTIVE) == HIGH);

  String currentMaterial  = "no paper";
  String currentFootprint = "--";
  String isMetalString    = "no";
  int targetAngle = ANGLE_HOME;
  int kruxCoins   = 0;

  // ---- Classification ----
  if (metalDetected) {
    currentMaterial = "METAL"; currentFootprint = "1.85 kg CO2/kg";
    targetAngle = ANGLE_METAL; kruxCoins = 5;
  } else if (sensorValue <= THRESH_NO_PAPER) {
    currentMaterial = "no paper"; currentFootprint = "--";
    targetAngle = ANGLE_HOME; kruxCoins = 0;
  } else if (sensorValue <= THRESH_HDPE_MAX) {
    currentMaterial = "HDPE"; currentFootprint = "1.19 MTCO2E/Ton";
    targetAngle = ANGLE_HDPE; kruxCoins = 12;
  } else if (sensorValue <= THRESH_PP_MAX) {
    currentMaterial = "PP"; currentFootprint = "0.84 kg CO2/kg";
    targetAngle = ANGLE_PP; kruxCoins = 11;
  } else {
    currentMaterial = "PET"; currentFootprint = "2.15 kg CO2/kg";
    targetAngle = ANGLE_PET; kruxCoins = 15;
  }

  // ---- Periodic Screen Update ----
  if (millis() - lastPrintTime > 2000) {
    if (!appConnected) {
      updateOLED("WAITING", "for app..", 0);
    } else {
      updateOLED(currentMaterial, currentFootprint, targetAngle);
    }
    lastPrintTime = millis();
  }

  // ============================================================
  //  FIREBASE HANDSHAKE - Check every 3 seconds
  // ============================================================
  if (millis() > 5000 && millis() - lastFirebaseCheck > 3000) {
    lastFirebaseCheck = millis();

    if (Firebase.ready()) {
      if (!firebaseReady) {
        firebaseReady = true;
        Serial.println(">> Firebase is READY. Polling for app connection...");
      }

      String statusPath = "/bins/" + String(BIN_ID) + "/status";

      if (Firebase.RTDB.getString(&fbdo, statusPath.c_str())) {
        String status = fbdo.stringData();
        
        // APP IS REQUESTING CONNECTION
        if (status == "requesting_connection") {
          Serial.println("\n>>> APP CONNECTED TO BIN SUCCESSFULLY! <<<\n");
          oledBig("APP", "CONNECTED!");

          // Reply back so the app unlocks its camera
          if (Firebase.RTDB.setString(&fbdo, statusPath.c_str(), "connected")) {
            Serial.println(">> Replied 'connected' to app. Handshake complete!");
          }
          appConnected = true;
          delay(2000); 
        }
      }
    }
  }

  // ============================================================
  //  ACTUATION - Only when IR triggers and material detected
  // ============================================================
  if (irState == LOW && currentMaterial != "no paper") {
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
      int servo2MappedAngle = targetAngle - 180;
      panServo2.attach(PIN_PAN_SERVO_2, 500, 2400);
      panServo2.write(servo2MappedAngle);
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

    notifyAppDropCompleted(kruxCoins);
    delay(1500);
  }
}