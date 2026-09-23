// LookUp bridge для macOS: наклон головы с наушников Apple (AirPods 3 / Pro / Max, Beats Fit Pro) → ws://127.0.0.1:8765
// Требуется macOS 14+ (CMHeadphoneMotionManager). Сборка: ./build.sh
// Формат сообщения: {"pitch":градусы,"roll":градусы,"yaw":градусы,"t":мс}. Сайт сам определяет знак кивком.
import Foundation
import CoreMotion
import Network

@available(macOS 14.0, *)
final class Bridge: NSObject, CMHeadphoneMotionManagerDelegate {
    let motion = CMHeadphoneMotionManager()
    var listener: NWListener?
    var conns: [ObjectIdentifier: NWConnection] = [:]
    var lastErrorLog = Date.distantPast

    func run() throws {
        switch CMHeadphoneMotionManager.authorizationStatus() {
        case .denied, .restricted:
            print("Нет доступа к движению. Системные настройки → Конфиденциальность и безопасность → Движение и фитнес: включите для lookup-bridge (или Terminal).")
        default:
            break
        }
        if !motion.isDeviceMotionAvailable {
            print("Пока нет совместимых наушников (AirPods 3 / Pro / Max, Beats Fit Pro) — жду подключения…")
        }
        motion.delegate = self
        try startServer()
        startUpdates()
        print("LookUp bridge: ws://127.0.0.1:8765 — наденьте наушники и откройте сайт (Ctrl+C — выход)")
        RunLoop.main.run()
    }

    // безопасно вызывать повторно: при (пере)подключении наушников запускаем поток данных заново
    func startUpdates() {
        if motion.isDeviceMotionActive { motion.stopDeviceMotionUpdates() }
        motion.startDeviceMotionUpdates(to: OperationQueue.main) { [weak self] m, err in
            guard let self = self else { return }
            if let err = err {
                if Date().timeIntervalSince(self.lastErrorLog) > 5 {
                    print("Ошибка датчика:", err.localizedDescription)
                    self.lastErrorLog = Date()
                }
                return
            }
            if let m = m { self.broadcast(m) }
        }
    }

    func startServer() throws {
        let params = NWParameters.tcp
        // только петля (loopback): наружу мост не виден
        params.requiredInterfaceType = .loopback
        params.defaultProtocolStack.applicationProtocols.insert(NWProtocolWebSocket.Options(), at: 0)
        let l = try NWListener(using: params, on: NWEndpoint.Port(rawValue: 8765)!)
        l.stateUpdateHandler = { s in
            if case .failed(let e) = s {
                print("Сервер не запустился (порт 8765 занят?):", e)
                exit(1)
            }
        }
        l.newConnectionHandler = { [weak self] c in
            guard let self = self else { return }
            let id = ObjectIdentifier(c)
            self.conns[id] = c
            c.stateUpdateHandler = { [weak self] s in
                switch s {
                case .failed, .cancelled: self?.conns[id] = nil
                default: break
                }
            }
            c.start(queue: .main)
            self.drain(c)
        }
        l.start(queue: .main)
        listener = l
    }

    // читаем входящие кадры (ping/close), чтобы соединение не зависало
    func drain(_ c: NWConnection) {
        c.receiveMessage { [weak self] _, _, _, err in
            if err == nil { self?.drain(c) }
        }
    }

    func broadcast(_ m: CMDeviceMotion) {
        if conns.isEmpty { return }
        let k = 180.0 / Double.pi
        let json = String(format: "{\"pitch\":%.2f,\"roll\":%.2f,\"yaw\":%.2f,\"t\":%.0f}",
                          m.attitude.pitch * k, m.attitude.roll * k, m.attitude.yaw * k,
                          Date().timeIntervalSince1970 * 1000)
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let ctx = NWConnection.ContentContext(identifier: "motion", metadata: [meta])
        for c in conns.values {
            c.send(content: json.data(using: .utf8), contentContext: ctx, isComplete: true, completion: .idempotent)
        }
    }

    func headphoneMotionManagerDidConnect(_ manager: CMHeadphoneMotionManager) {
        print("Наушники подключены")
        startUpdates()
    }
    func headphoneMotionManagerDidDisconnect(_ manager: CMHeadphoneMotionManager) { print("Наушники отключены") }
}

if #available(macOS 14.0, *) {
    let bridge = Bridge()
    do { try bridge.run() } catch { print("Не удалось запустить сервер:", error); exit(1) }
} else {
    print("Нужна macOS 14 или новее.")
    exit(1)
}
