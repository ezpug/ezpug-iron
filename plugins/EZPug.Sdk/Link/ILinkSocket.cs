using System.Net.WebSockets;
using System.Text;

namespace EZPug.Sdk;

/// <summary>How a socket ended, both directions.</summary>
public sealed record LinkClosure(int Code, string Reason)
{
    public override string ToString() => Reason.Length == 0 ? Code.ToString() : $"{Code} ({Reason})";
}

/// <summary>What one receive produced: a text frame, or the peer's close.</summary>
public abstract record LinkReceived
{
    public sealed record Text(string Payload) : LinkReceived;

    public sealed record Closed(LinkClosure Closure) : LinkReceived;
}

/// <summary>
/// The corner of a WebSocket the link client uses, so a test hands it a scripted socket
/// and production hands it <see cref="ClientWebSocketFactory"/>. One reader and one
/// writer at a time, which is also what <see cref="ClientWebSocket"/> allows.
/// </summary>
public interface ILinkSocket : IAsyncDisposable
{
    Task SendAsync(string text, CancellationToken cancellationToken);

    /// <summary>The next text frame, or the close that ended the socket. A transport failure is a <see cref="LinkReceived.Closed"/> with code 1006.</summary>
    Task<LinkReceived> ReceiveAsync(CancellationToken cancellationToken);

    Task CloseAsync(int code, string reason, CancellationToken cancellationToken);
}

public interface ILinkSocketFactory
{
    /// <summary>Open a socket to <paramref name="url"/>. Throws on a refused or failed handshake.</summary>
    Task<ILinkSocket> ConnectAsync(Uri url, CancellationToken cancellationToken);
}

/// <summary>Production: <see cref="ClientWebSocket"/>, the outbound socket every server dials (decision 5).</summary>
public sealed class ClientWebSocketFactory : ILinkSocketFactory
{
    public async Task<ILinkSocket> ConnectAsync(Uri url, CancellationToken cancellationToken)
    {
        var socket = new ClientWebSocket();
        try
        {
            await socket.ConnectAsync(url, cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            socket.Dispose();
            throw;
        }

        return new Adapter(socket);
    }

    private sealed class Adapter : ILinkSocket
    {
        private readonly ClientWebSocket _socket;
        private readonly byte[] _buffer = new byte[64 * 1024];

        public Adapter(ClientWebSocket socket)
        {
            _socket = socket;
        }

        public Task SendAsync(string text, CancellationToken cancellationToken) =>
            _socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, endOfMessage: true, cancellationToken);

        public async Task<LinkReceived> ReceiveAsync(CancellationToken cancellationToken)
        {
            using var message = new MemoryStream();
            try
            {
                while (true)
                {
                    var result = await _socket.ReceiveAsync(_buffer, cancellationToken).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        return new LinkReceived.Closed(new LinkClosure((int?)_socket.CloseStatus ?? 1005, _socket.CloseStatusDescription ?? ""));
                    }

                    message.Write(_buffer, 0, result.Count);
                    if (result.EndOfMessage)
                    {
                        break;
                    }
                }
            }
            catch (WebSocketException error)
            {
                return new LinkReceived.Closed(new LinkClosure(1006, error.Message));
            }

            return new LinkReceived.Text(Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length));
        }

        public async Task CloseAsync(int code, string reason, CancellationToken cancellationToken)
        {
            if (_socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                try
                {
                    await _socket.CloseAsync((WebSocketCloseStatus)code, reason, cancellationToken).ConfigureAwait(false);
                }
                catch (WebSocketException)
                {
                    // The peer went first; there is nothing left to close.
                }
            }
        }

        public ValueTask DisposeAsync()
        {
            _socket.Dispose();
            return ValueTask.CompletedTask;
        }
    }
}
