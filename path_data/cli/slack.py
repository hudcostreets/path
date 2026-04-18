from json import dumps, loads
from urllib.request import Request, urlopen

from click import argument, option
from thrds import SlackClient, Thread
from utz import err

from path_data.cli.base import path_data

BOT_USERNAME = 'PATH Data'


def get_client(token: str, channel: str) -> SlackClient:
    return SlackClient(token=token, channel=channel)


def post_message(
    text: str,
    channel: str,
    token: str,
    username: str | None = None,
    icon_emoji: str | None = None,
    thread_ts: str | None = None,
):
    """Post a message to Slack via the Bot API. Pass `thread_ts` to reply
    in an existing thread (use the `ts` of the parent message)."""
    payload = dict(channel=channel, text=text)
    if username:
        payload['username'] = username
    if icon_emoji:
        payload['icon_emoji'] = icon_emoji
    if thread_ts:
        payload['thread_ts'] = thread_ts

    data = dumps(payload).encode()
    req = Request(
        'https://slack.com/api/chat.postMessage',
        data=data,
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
        },
    )
    with urlopen(req) as resp:
        body = resp.read().decode()

    result = loads(body)
    if not result.get('ok'):
        raise RuntimeError(f"Slack API error: {result.get('error', body)}")
    return result


def latest_bot_message(
    client: SlackClient,
    username: str = BOT_USERNAME,
    limit: int = 20,
) -> dict | None:
    """Return the most recent top-level message posted by our bot."""
    result = client._request("conversations.history", {
        "channel": client.channel,
        "limit": limit,
    }, method="GET")
    for msg in result.get('messages', []):
        if msg.get('username') == username:
            return msg
    return None


@path_data.command('slack')
@option('-c', '--channel', envvar='SLACK_CHANNEL_ID', required=True, help='Slack channel ID')
@option('-e', '--icon-emoji', default=':train:', help='Bot icon emoji')
@option('-t', '--token', envvar='SLACK_BOT_TOKEN', required=True, help='Slack bot token')
@option('-u', '--username', default='PATH Data', help='Bot display name')
@argument('message')
def slack(channel: str, icon_emoji: str, token: str, username: str, message: str):
    """Post a notification to Slack."""
    result = post_message(
        text=message,
        channel=channel,
        token=token,
        username=username,
        icon_emoji=icon_emoji,
    )
    err(f"Posted to #{channel}: ts={result.get('ts')}")
