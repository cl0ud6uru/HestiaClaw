from __future__ import annotations

import aiohttp
from homeassistant.components import conversation
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import intent
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import CONF_TOKEN, CONF_URL, DOMAIN


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    async_add_entities([HestiaConversationAgent(config_entry)])


class HestiaConversationAgent(conversation.ConversationEntity):
    _attr_has_entity_name = True
    _attr_supported_languages = conversation.MATCH_ALL

    def __init__(self, entry: ConfigEntry) -> None:
        self._entry = entry
        self._url = entry.data[CONF_URL].rstrip("/")
        self._token = entry.data.get(CONF_TOKEN, "")
        self._attr_unique_id = entry.entry_id
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": "Hestia",
            "manufacturer": "HestiaClaw",
            "model": "AI Home Assistant",
        }

    @property
    def name(self) -> str:
        return "Hestia"

    async def async_process(
        self, user_input: conversation.ConversationInput
    ) -> conversation.ConversationResult:
        response = intent.IntentResponse(language=user_input.language)
        headers = {"Content-Type": "application/json"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"

        try:
            async with aiohttp.ClientSession() as sess:
                async with sess.post(
                    f"{self._url}/api/ha-voice/process",
                    json={
                        "text": user_input.text,
                        "conversation_id": user_input.conversation_id,
                        "language": user_input.language,
                    },
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=30),
                ) as resp:
                    if resp.status == 401:
                        response.async_set_error(
                            intent.IntentResponseErrorCode.UNKNOWN,
                            "Authentication failed — check the voice token in the Hestia integration settings.",
                        )
                    elif resp.status >= 400:
                        response.async_set_error(
                            intent.IntentResponseErrorCode.UNKNOWN,
                            "Could not reach HestiaClaw. Is the add-on running?",
                        )
                    else:
                        data = await resp.json()
                        response.async_set_speech(data.get("speech", ""))
                        return conversation.ConversationResult(
                            response=response,
                            conversation_id=data.get("conversation_id", user_input.conversation_id),
                        )
        except TimeoutError:
            response.async_set_error(
                intent.IntentResponseErrorCode.UNKNOWN,
                "HestiaClaw took too long to respond.",
            )
        except Exception as err:  # noqa: BLE001
            response.async_set_error(
                intent.IntentResponseErrorCode.UNKNOWN,
                f"Error communicating with HestiaClaw: {err}",
            )

        return conversation.ConversationResult(
            response=response,
            conversation_id=user_input.conversation_id,
        )
