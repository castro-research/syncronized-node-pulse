require "http/server"
require "crypto/subtle"
require "html"
require "json"
require "uuid"
require "sqlite3"

# Metronome server: serves the front end (src/web), the time (/time) and the rooms (/api/rooms).
# Rooms live in memory and are mirrored to SQLite so they survive a restart.
# Variables: HOST, PORT, WEB_DIR, DB_PATH, PUBLIC_URL.

WEB_DIR    = File.expand_path(ENV["WEB_DIR"]? || File.join(__DIR__, "web"))
PUBLIC_URL = (ENV["PUBLIC_URL"]? || "").rchop("/") # e.g. https://example.com; link previews need absolute URLs
BPM_RANGE  = 30..240
MAX_ROOMS  = 500                  # ponytail: fixed cap; rate limit per IP if this gets exposed to a lot of people
ROOM_TTL   = 12 * 3600 * 1000_i64 # a room nobody visits for 12 h is deleted
PRESENCE   = 10_000_i64           # whoever has not polled the room for 10 s drops off the list
MAX_BODY   = 2048
SAVE_EVERY = 600_000_i64          # visits only rewrite "touched" on disk every 10 min

# index.html has {{placeholders}} for the title, description and URLs of the link preview.
INDEX      = File.read(File.join(WEB_DIR, "index.html"))
HOME_TITLE = "Global Metronome: every device, the same beat"
HOME_DESC  = "Create a room, share the link or the QR code, and everyone hears the click on the same beat. Nothing to install."

STORE = DB.open("sqlite3://#{File.expand_path(ENV["DB_PATH"]? || "pulse.db")}")
STORE.exec "create table if not exists rooms (id text primary key, owner text not null, bpm integer not null, t0 integer not null, touched integer not null)"
# migration: databases created back when rooms had a name; fails (and is ignored) once the column is gone
STORE.exec("alter table rooms drop column name") rescue nil
# migration: rooms from before the manager key get an empty one, so nobody can change their BPM
STORE.exec("alter table rooms add column key text not null default ''") rescue nil

def now_ms : Int64
  Time.utc.to_unix_ms
end

# A name coming from the client: no control characters and at most 40 characters.
def clean(value : String?, fallback : String) : String
  s = value.to_s.gsub(/[[:cntrl:]]/, "").strip
  s = s[0, 40]
  s.empty? ? fallback : s
end

# A room is (t0, bpm): the instant the BPM was set, on the server clock, and the BPM.
# From that everyone works out the same beat grid on their own (see "How it works").
class Room
  getter id : String
  getter owner : String
  getter bpm : Int32 = 120
  getter t0 : Int64
  getter touched : Int64
  getter key : String # secret handed only to whoever created the room: it is what makes them the manager
  @saved = 0_i64 # the value of touched that is on disk
  @members = {} of String => Int64

  def initialize(@id, @owner)
    @key = Random::Secure.hex(16)
    @t0 = @touched = now_ms
    seen(@owner)
  end

  # A room read from disk: presence is not stored, it comes back by itself within seconds.
  def initialize(@id, @owner, @bpm, @t0, @touched, @key)
    @saved = @touched
  end

  # Writes to disk. With force: false it only does so if the touched on disk is already old.
  def save(force = true)
    return unless force || @touched - @saved > SAVE_EVERY
    STORE.exec "insert or replace into rooms (id, owner, bpm, t0, touched, key) values (?, ?, ?, ?, ?, ?)", @id, @owner, @bpm, @t0, @touched, @key
    @saved = @touched
  end

  def set_bpm(bpm : Int32)
    @bpm = bpm
    @t0 = @touched = now_ms
  end

  # Only the manager may change the BPM. An empty key (old rooms) matches nobody.
  def manager?(key : String?) : Bool
    !@key.empty? && !key.nil? && Crypto::Subtle.constant_time_compare(@key, key)
  end

  def seen(who : String)
    t = now_ms
    @touched = t
    @members.reject! { |_, at| at < t - PRESENCE }
    @members[who] = t
  end

  # with_key: only in the response to the request that created the room.
  def write(io : IO, with_key = false)
    JSON.build(io) do |j|
      j.object do
        j.field "id", @id
        j.field "key", @key if with_key
        j.field "owner", @owner
        j.field "bpm", @bpm
        j.field "t0", @t0
        j.field "members" do
          j.array { @members.each { |n, at| j.string(n) if at >= now_ms - PRESENCE } }
        end
      end
    end
  end
end

class Api
  include HTTP::Handler

  ROOMS = {} of String => Room
  STORE.exec "delete from rooms where touched < ?", now_ms - ROOM_TTL
  STORE.query_each "select id, owner, bpm, t0, touched, key from rooms" do |rs|
    room = Room.new(rs.read(String), rs.read(String), rs.read(Int32), rs.read(Int64), rs.read(Int64), rs.read(String))
    ROOMS[room.id] = room
  end

  def call(context : HTTP::Server::Context)
    ctx = context
    req = ctx.request
    read = {"GET", "HEAD"}.includes?(req.method)
    ctx.response.headers["Cache-Control"] = "no-cache"
    ctx.response.headers["X-Content-Type-Options"] = "nosniff"
    ctx.response.headers["Content-Security-Policy"] =
      "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"

    case
    when req.path == "/time" && req.method == "GET"
      time(ctx)
    when req.path == "/api/rooms" && req.method == "POST"
      create(ctx)
    when m = req.path.match(%r{\A/api/rooms/([^/]+)\z})
      room(ctx, m[1])
    when read && (req.path == "/" || req.path == "/index.html")
      page(ctx, nil)
    when read && (m = req.path.match(%r{\A/(?:room|sala)/([^/]*)\z})) # /sala/ is the old path
      page(ctx, m[1].downcase) # the front end resolves the route
    else
      call_next(ctx)
    end
  end

  # The page itself. A room link gets its own preview ("Join Ana's room"), so whoever
  # receives it in a chat sees who is inviting before opening it.
  private def page(ctx, id : String?)
    room = id.try { |i| ROOMS[i]? }
    vars = {
      "origin"      => PUBLIC_URL,
      "url"         => room ? "#{PUBLIC_URL}/room/#{room.id}" : "#{PUBLIC_URL}/",
      "title"       => room ? "Join #{room.owner}'s room · Global Metronome" : HOME_TITLE,
      "description" => room ? "#{room.owner} started a shared metronome. Open the link and hear the click on the same beat, on any device." : HOME_DESC,
    }
    ctx.response.content_type = "text/html; charset=utf-8"
    ctx.response.print INDEX.gsub(/\{\{(\w+)\}\}/) { |_, m| HTML.escape(vars[m[1]]) }
  end

  # Server time in Unix ms, with a fraction. It is the time reference for every room.
  private def time(ctx)
    ctx.response.headers["Cache-Control"] = "no-store"
    ctx.response.content_type = "text/plain"
    ctx.response.print Time.utc.to_unix_f * 1000
  end

  private def json(ctx, status : Int32, &)
    ctx.response.status_code = status
    ctx.response.content_type = "application/json"
    ctx.response.headers["Cache-Control"] = "no-store"
    yield ctx.response
  end

  private def fail(ctx, status : Int32, message : String)
    json(ctx, status) { |io| {error: message}.to_json(io) }
  end

  private def body(ctx) : Hash(String, JSON::Any)?
    raw = ctx.request.body
    return unless raw
    JSON.parse(IO::Sized.new(raw, MAX_BODY).gets_to_end).as_h?
  rescue JSON::ParseException
    nil
  end

  private def create(ctx)
    data = body(ctx) || return fail(ctx, 400, "invalid JSON")
    ROOMS.reject! do |id, r|
      (r.touched < now_ms - ROOM_TTL).tap { |old| STORE.exec("delete from rooms where id = ?", id) if old }
    end
    return fail(ctx, 503, "too many rooms") if ROOMS.size >= MAX_ROOMS
    room = Room.new(UUID.random.to_s, clean(data["owner"]?.try(&.as_s?), "guest"))
    ROOMS[room.id] = room
    room.save
    json(ctx, 201) { |io| room.write(io, with_key: true) }
  end

  private def room(ctx, id : String)
    room = ROOMS[id]? || return fail(ctx, 404, "room not found")
    case ctx.request.method
    when "GET"
      who = clean(ctx.request.query_params["who"]?, "")
      room.seen(who) unless who.empty?
      room.save(force: false)
    when "PUT"
      data = body(ctx) || return fail(ctx, 400, "invalid JSON")
      return fail(ctx, 403, "only the room manager can change the BPM") unless room.manager?(data["key"]?.try(&.as_s?))
      bpm = data["bpm"]?.try(&.as_i?)
      return fail(ctx, 422, "bpm must be an integer between #{BPM_RANGE.begin} and #{BPM_RANGE.end}") unless bpm && BPM_RANGE.includes?(bpm)
      room.set_bpm(bpm)
      who = clean(data["who"]?.try(&.as_s?), "")
      room.seen(who) unless who.empty?
      room.save
    else
      return fail(ctx, 405, "method not allowed")
    end
    json(ctx, 200) { |io| room.write(io) }
  end
end

host = ENV["HOST"]? || "127.0.0.1"
port = (ENV["PORT"]? || "8080").to_i
server = HTTP::Server.new([
  Api.new,
  HTTP::StaticFileHandler.new(WEB_DIR, fallthrough: false, directory_listing: false),
])
server.bind_tcp host, port
puts "http://#{host}:#{port}  (front end: #{WEB_DIR}, #{Api::ROOMS.size} rooms on disk)"
{Signal::INT, Signal::TERM}.each &.trap { server.close } # so docker stop ends right away
server.listen
