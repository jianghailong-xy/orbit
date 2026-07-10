import SwiftUI

/// An SVG path (absolute `M`/`L`/`C`/`Z` only) rendered as a SwiftUI `Shape`, aspect-fit and
/// centered into the target rect from a 24×24 viewBox.
///
/// Brand marks are drawn as vectors rather than asset-catalog images because the agent avatar is
/// shared source compiled into *both* clients, and the macOS app ships no compiled asset catalog
/// (its DMG build makes an `.icns` with `iconutil`, never runs `actool`) — so an `Image("…")`
/// would resolve on iOS yet render blank on macOS. A vector path renders identically on both.
struct VectorMark: Shape {
    /// Path data normalized offline to absolute `M L C Z` (elliptical arcs flattened to cubics).
    /// Numbers are whitespace-separated; a command letter may be glued to its first number
    /// (e.g. `C-0.06 …`). Filled non-zero, matching the source artwork's winding.
    let pathData: String
    var viewBox: CGFloat = 24

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / viewBox
        let ox = rect.midX - viewBox * scale / 2
        let oy = rect.midY - viewBox * scale / 2
        func map(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * scale, y: oy + y * scale) }

        let tokens = Self.tokenize(pathData)
        var path = Path()
        var i = 0
        func num() -> CGFloat {
            defer { i += 1 }
            if i < tokens.count, case let .number(v) = tokens[i] { return v }
            return 0
        }
        var last: Character = "M"
        while i < tokens.count {
            var cmd = last
            if case let .command(c) = tokens[i] { cmd = c; i += 1 }
            last = cmd
            switch cmd {
            case "M": path.move(to: map(num(), num()))
            case "L": path.addLine(to: map(num(), num()))
            case "C":
                let c1 = map(num(), num()), c2 = map(num(), num()), end = map(num(), num())
                path.addCurve(to: end, control1: c1, control2: c2)
            case "Z": path.closeSubpath()
            default: i += 1   // unreachable for normalized data; guards against a stray token
            }
        }
        return path
    }

    private enum Token { case command(Character); case number(CGFloat) }

    private static func tokenize(_ s: String) -> [Token] {
        var tokens: [Token] = []
        var buf = ""
        func flush() {
            if !buf.isEmpty { tokens.append(.number(CGFloat(Double(buf) ?? 0))); buf = "" }
        }
        for ch in s {
            switch ch {
            case "M", "L", "C", "Z": flush(); tokens.append(.command(ch))
            case " ", ",", "\n", "\t": flush()
            case "-", "+":
                // A sign starts a new number. Our data space-separates every number, but split
                // defensively — unless it's an exponent sign (no exponents in the normalized data).
                if !buf.isEmpty, buf.last != "e", buf.last != "E" { flush() }
                buf.append(ch)
            default: buf.append(ch)
            }
        }
        flush()
        return tokens
    }
}

/// Which provider an agent avatar should brand. Only providers we can render with their official
/// mark claim one; anything else keeps the neutral Orbit `>_` glyph so we never mis-brand (e.g.
/// DeepSeek, which reuses Claude models but is its own product). Mirrors the server's "anything
/// that isn't `codex` is Claude" rule for the default, but scoped to marks we can draw officially.
enum AgentBrand {
    case claude, codex, generic

    static func from(_ provider: String?) -> AgentBrand {
        switch provider?.lowercased() {
        case "codex", "openai":          return .codex
        case "claude", "anthropic", nil: return .claude
        default:                         return .generic
        }
    }

    /// The official mark's path, or `nil` for `.generic` (which renders the `>_` glyph instead).
    var markPath: String? {
        switch self {
        case .claude:  return Self.claudeMark
        case .codex:   return Self.codexMark
        case .generic: return nil
        }
    }

    /// Mark diameter as a fraction of the avatar. The airy radial sunburst reads smaller than its
    /// bounding box, so it sits a hair larger than the solid blossom to optically balance the pair.
    var markScale: CGFloat {
        switch self {
        case .claude:  return 0.54
        case .codex:   return 0.50
        case .generic: return 0
        }
    }

    // Canonical simple-icons artwork (viewBox 0 0 24 24), normalized offline to absolute M/L/C/Z.
    // Anthropic "Claude" sunburst.
    static let claudeMark = "M4.7144 15.9555 L9.4318 13.3084 L9.5108 13.0777 L9.4318 12.9502 L9.2011 12.9502 L8.4118 12.9016 L5.7162 12.8287 L3.3787 12.7316 L1.1141 12.6102 L0.5434 12.4887 L0.0091 11.7845 L0.0637 11.4323 L0.5434 11.1105 L1.2294 11.1713 L2.7473 11.2745 L5.024 11.4323 L6.6754 11.5295 L9.1222 11.7845 L9.5108 11.7845 L9.5654 11.6266 L9.4318 11.5295 L9.3286 11.4323 L6.973 9.8356 L4.423 8.1477 L3.0874 7.1763 L2.3649 6.6845 L2.0006 6.2231 L1.8428 5.2153 L2.4985 4.4928 L3.3788 4.5535 L3.6034 4.6142 L4.4959 5.3002 L6.4023 6.7756 L8.8916 8.6092 L9.2559 8.9127 L9.4016 8.8095 L9.4198 8.7367 L9.2558 8.4634 L7.9019 6.0167 L6.4569 3.5274 L5.8134 2.4954 L5.6434 1.876 C5.5827 1.621 5.5402 1.4086 5.5402 1.1475 L6.287 0.1335 L6.6997 0 L7.6954 0.1336 L8.1144 0.4978 L8.7336 1.9125 L9.7354 4.1407 L11.2897 7.1703 L11.745 8.0688 L11.9879 8.9006 L12.0789 9.1556 L12.2368 9.1556 L12.2368 9.0099 L12.3643 7.3039 L12.6011 5.2092 L12.8318 2.5135 L12.9107 1.7546 L13.2871 0.8439 L14.0339 0.3521 L14.6167 0.6314 L15.0964 1.3174 L15.0296 1.7607 L14.7443 3.6124 L14.1857 6.5145 L13.8214 8.4574 L14.0339 8.4574 L14.2768 8.2145 L15.2603 6.9092 L16.9117 4.8449 L17.6403 4.0253 L18.4903 3.1207 L19.0367 2.6896 L20.0688 2.6896 L20.8278 3.8189 L20.4878 4.9846 L19.4253 6.3324 L18.5449 7.4738 L17.2821 9.1738 L16.4928 10.5338 L16.5657 10.6431 L16.7539 10.6248 L19.6074 10.0178 L21.1495 9.7384 L22.9891 9.4227 L23.8209 9.8113 L23.9119 10.2059 L23.5841 11.0134 L21.6171 11.4991 L19.3099 11.9605 L15.8735 12.7741 L15.831 12.8045 L15.8796 12.8652 L17.4278 13.0109 L18.0896 13.0473 L19.7106 13.0473 L22.7281 13.272 L23.5173 13.794 L23.9909 14.4316 L23.9119 14.9173 L22.6977 15.5366 L21.0584 15.148 L17.2334 14.2373 L15.9221 13.9094 L15.7399 13.9094 L15.7399 14.0187 L16.8328 15.0873 L18.8363 16.8965 L21.3438 19.2279 L21.4713 19.8047 L21.1495 20.2601 L20.8095 20.2115 L18.6056 18.554 L17.7556 17.8072 L15.831 16.1862 L15.7035 16.1862 L15.7035 16.3562 L16.1467 17.0058 L18.4903 20.5272 L18.6117 21.6079 L18.4417 21.96 L17.8346 22.1725 L17.1667 22.0511 L15.7946 20.1265 L14.38 17.959 L13.2386 16.0162 L13.0989 16.0952 L12.4249 23.3504 L12.1093 23.7207 L11.3807 24 L10.7736 23.5386 L10.4518 22.7918 L10.7736 21.3165 L11.1622 19.3919 L11.4779 17.8619 L11.7632 15.9615 L11.9332 15.3301 L11.9211 15.2876 L11.7814 15.3058 L10.3486 17.273 L8.169 20.2176 L6.4447 22.0632 L6.0319 22.2272 L5.3155 21.8568 L5.3822 21.195 L5.783 20.6061 L8.169 17.5704 L9.6079 15.6884 L10.5369 14.6016 L10.5307 14.4437 L10.4761 14.4437 L4.1376 18.5601 L3.0083 18.7058 L2.5226 18.2504 L2.5834 17.5037 L2.8141 17.2608 L4.7205 15.9494 Z"

    // OpenAI "Codex" blossom.
    static let codexMark = "M22.2819 9.8211 C22.8248 8.1862 22.6369 6.3967 21.7662 4.9103 C20.4571 2.6316 17.826 1.4595 15.2564 2.0103 C13.8083 0.3995 11.6112 -0.3168 9.492 0.1311 C7.3728 0.5789 5.6533 2.1229 4.9807 4.1818 C3.2928 4.5279 1.836 5.5847 0.983 7.0818 C-0.3404 9.3568 -0.0401 12.2267 1.7257 14.1784 C1.1808 15.8125 1.367 17.6022 2.2367 19.0891 C3.5475 21.3686 6.1803 22.5406 8.7513 21.9892 C9.8948 23.277 11.5377 24.0097 13.2599 24 C15.8937 24.0024 18.2271 22.3021 19.0317 19.7942 C20.7194 19.4475 22.176 18.3908 23.0294 16.8941 C24.3368 14.6231 24.0351 11.7688 22.2819 9.8212 Z M13.2599 22.4292 C12.2086 22.4309 11.1903 22.0624 10.3835 21.3884 L10.5254 21.308 L15.3037 18.5498 C15.5456 18.4079 15.6949 18.149 15.6964 17.8685 L15.6964 11.1316 L17.7164 12.3002 C17.7367 12.3105 17.7508 12.3298 17.7544 12.3522 L17.7544 17.9348 C17.7491 20.4148 15.7399 22.424 13.2599 22.4292 Z M3.5992 18.3038 C3.072 17.3934 2.8827 16.3263 3.0646 15.2901 L3.2066 15.3753 L7.9896 18.1335 C8.2306 18.2749 8.5292 18.2749 8.7702 18.1335 L14.613 14.765 L14.613 17.0974 C14.6119 17.1219 14.5997 17.1445 14.5798 17.1589 L9.74 19.9502 C7.5893 21.1891 4.8416 20.4525 3.5992 18.3038 Z M2.3408 7.8956 C2.8717 6.9794 3.7096 6.2805 4.7063 5.9228 L4.7063 11.6 C4.7026 11.8793 4.8513 12.1386 5.0942 12.2765 L10.9086 15.6308 L8.8885 16.7993 C8.8663 16.8111 8.8397 16.8111 8.8175 16.7993 L3.9872 14.0128 C1.8408 12.7686 1.1047 10.023 2.3408 7.872 Z M18.9371 11.7514 L13.1038 8.364 L15.1192 7.2 C15.1414 7.1882 15.168 7.1882 15.1902 7.2 L20.0205 9.9913 C21.5281 10.8612 22.3979 12.5234 22.2531 14.258 C22.1083 15.9926 20.975 17.4876 19.344 18.0955 L19.344 12.4183 C19.3355 12.1397 19.1808 11.8863 18.937 11.7513 Z M20.9478 8.7283 L20.8058 8.6431 L16.0323 5.8613 C15.7898 5.719 15.4894 5.719 15.2469 5.8613 L9.409 9.2297 L9.409 6.8974 C9.4065 6.8732 9.4174 6.8496 9.4374 6.8359 L14.2677 4.0493 C15.779 3.1787 17.6573 3.2599 19.0877 4.2578 C20.5182 5.2556 21.2431 6.9903 20.9479 8.7093 Z M8.3065 12.863 L6.2865 11.6992 C6.266 11.6869 6.2521 11.6661 6.2485 11.6425 L6.2485 6.0742 C6.2508 4.3304 7.2605 2.7449 8.8397 2.0054 C10.419 1.2659 12.2833 1.5056 13.6242 2.6205 L13.4822 2.701 L8.704 5.459 C8.4621 5.6009 8.3128 5.8598 8.3113 6.1403 Z M9.4041 10.4976 L12.0061 8.9978 L14.613 10.4976 L14.613 13.497 L12.0156 14.9967 L9.4089 13.497 Z"
}
