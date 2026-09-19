// LookUp bridge для macOS: наклон головы с AirPods (Pro / Max / 3 / 4, Beats Fit Pro) → ws://127.0.0.1:8765
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

    func run() throws {
        guard motion.isDeviceMotionAvailable else {
            print("Движение наушников недоступно: нужны AirPods Pro/Max/3/4 и macOS 14+.")
            exit(1)
        }
        motion.delegate = self
        try startServer()
        motion.startDeviceMotionUpdates(to: OperationQueue.main) { [weak self] m, err in
            if let err = err { print("Ошибка датчика:", err.localizedDescription); return }
            guard let self = self, let m = m else { return }
            self.broadcast(m)
        }
        print("LookUp bridge: ws://127.0.0.1:8765 — наденьте AirPods и откройте сайт (Ctrl+C — выход)")
        RunLoop.main.run()
    }

    func startServer() throws {
        let params = NWParameters.tcp
        params.defaultProtocolStack.applicationProtocols.insert(NWProtocolWebSocket.Options(), at: 0)
        // только локальный интерфейс: наружу мост не виден
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(integerLiteral: 8765))
        let l = try NWListener(using: params)
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

    func headphoneMotionManagerDidConnect(_ manager: CMHeadphoneMotionManager) { print("🎧 подключены") }
    func headphoneMotionManagerDidDisconnect(_ manager: CMHeadphoneMotionManager) { print("🎧 отключены") }
}

if #available(macOS 14.0, *) {
    let bridge = Bridge()
    do { try bridge.run() } catch { print("Не удалось запустить сервер:", error); exit(1) }
} else {
    print("Нужна macOS 14 или новее.")
    exit(1)
}
