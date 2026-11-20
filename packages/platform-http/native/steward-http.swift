import Dispatch
import Foundation

private let inputLimit = 4 * 1024 * 1024
private let responseLimit = 32 * 1024 * 1024
private let requestTimeout: TimeInterval = 30

private enum HTTPFailure: String, Error {
    case invalidRequest = "invalid_request"
    case networkError = "network_error"
    case timeout
    case invalidResponse = "invalid_response"
}

private struct Input: Decodable {
    enum Method: String, Decodable { case get = "GET", post = "POST", patch = "PATCH" }

    let url: String
    let method: Method
    let headers: [String: String]
    let body: String?
}

private struct Output: Encodable {
    let status: Int?
    let bodyBase64: String?
    let error: String?

    init(status: Int, body: Data) {
        self.status = status
        self.bodyBase64 = body.base64EncodedString()
        self.error = nil
    }

    init(error: HTTPFailure) {
        self.status = nil
        self.bodyBase64 = nil
        self.error = error.rawValue
    }
}

private func readInput() throws -> Input {
    let handle = FileHandle.standardInput
    var data = Data()
    while let chunk = try handle.read(upToCount: min(64 * 1024, inputLimit + 1 - data.count)), !chunk.isEmpty {
        data.append(chunk)
        guard data.count <= inputLimit else { throw HTTPFailure.invalidRequest }
    }
    return try JSONDecoder().decode(Input.self, from: data)
}

private func parsedURL(_ raw: String) -> URLComponents? {
    guard !raw.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 || $0 == "\\" }),
          let components = URLComponents(string: raw),
          let host = components.host, !host.isEmpty,
          components.user == nil, components.password == nil, components.fragment == nil,
          components.port.map({ (1...65535).contains($0) }) ?? true else { return nil }
    return components
}

private func isHeaderNameByte(_ byte: UInt8) -> Bool {
    switch byte {
    case 48...57, 65...90, 97...122: return true
    default: return "!#$%&'*+-.^_`|~".utf8.contains(byte)
    }
}

private func makeRequest(_ input: Input) throws -> URLRequest {
    guard let target = parsedURL(input.url), let url = target.url,
          let scheme = target.scheme?.lowercased(),
          scheme == "https" || (scheme == "http" && ["127.0.0.1", "[::1]"].contains(target.host ?? "")) else {
        throw HTTPFailure.invalidRequest
    }
    var request = URLRequest(url: url, timeoutInterval: requestTimeout)
    request.httpMethod = input.method.rawValue
    if let body = input.body { request.httpBody = Data(body.utf8) }
    for (name, value) in input.headers {
        guard !name.isEmpty, name.utf8.allSatisfy(isHeaderNameByte),
              value.utf8.allSatisfy({ $0 == 9 || ($0 >= 32 && $0 != 127) }) else {
            throw HTTPFailure.invalidRequest
        }
        request.setValue(value, forHTTPHeaderField: name)
    }
    return request
}

private func makeConfiguration() -> URLSessionConfiguration {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = requestTimeout
    config.timeoutIntervalForResource = requestTimeout
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.urlCredentialStorage = nil
    config.urlCache = nil
    return config
}

private final class Transfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    // URLSession 以串行 delegate queue 调用。完成信号发出后，主线程才读取响应。
    private let completed = DispatchSemaphore(value: 0)
    private var body = Data()
    private var failure: HTTPFailure?
    private var output: Output?

    func run(request: URLRequest, configuration: URLSessionConfiguration) -> Output {
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        session.dataTask(with: request).resume()
        if completed.wait(timeout: .now() + requestTimeout) == .timedOut {
            session.invalidateAndCancel()
            return Output(error: .timeout)
        }
        session.finishTasksAndInvalidate()
        return output ?? Output(error: .invalidResponse)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard response is HTTPURLResponse, response.expectedContentLength <= Int64(responseLimit) else {
            failure = .invalidResponse
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard failure == nil else { return }
        guard data.count <= responseLimit - body.count else {
            failure = .invalidResponse
            dataTask.cancel()
            return
        }
        body.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer { completed.signal() }
        if let failure {
            output = Output(error: failure)
        } else if let error {
            output = Output(error: (error as? URLError)?.code == .timedOut ? .timeout : .networkError)
        } else if let response = task.response as? HTTPURLResponse {
            output = Output(status: response.statusCode, body: body)
        } else {
            output = Output(error: .invalidResponse)
        }
    }
}

private func execute() -> Output {
    do {
        let input = try readInput()
        let request = try makeRequest(input)
        return Transfer().run(request: request, configuration: makeConfiguration())
    } catch {
        return Output(error: .invalidRequest)
    }
}

private let output = execute()
private let encoder = JSONEncoder()
encoder.outputFormatting = [.withoutEscapingSlashes]
if let data = try? encoder.encode(output) {
    try? FileHandle.standardOutput.write(contentsOf: data)
}
