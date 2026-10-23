"""Agent APIs: credentials stay in the backend; the selected mode governs proposal execution."""

from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, StringConstraints

from taskradar.api.deps import get_container
from taskradar.container import Container
from taskradar.domain.agent import AgentConfigUpdate, AgentPreferences

router = APIRouter(prefix="/api/agent", tags=["AI Agent"])


@router.get("/config")
def config(c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.agent.status()


@router.put("/config")
def configure(body: AgentConfigUpdate, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.agent.configure(body)


@router.patch("/config")
def preferences(body: AgentPreferences, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.agent.preferences(body)


@router.get("/models")
def models(refresh: bool = False, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.agent.models(refresh=refresh)


@router.delete("/key")
def forget_key(c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.agent.forget_key()


@router.get("/conversations")
def conversations(c: Container = Depends(get_container)) -> dict[str, Any]:
    return {"items": c.agent.conversations()}


@router.post("/conversations", status_code=201)
def new_conversation(c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.agent.new_conversation()


@router.get("/conversations/{conversation_id}")
def history(conversation_id: UUID, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.agent.history(str(conversation_id))


@router.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: UUID, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.agent.delete_conversation(str(conversation_id))


class RenameBody(BaseModel):
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


@router.patch("/conversations/{conversation_id}")
def rename(conversation_id: UUID, body: RenameBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.agent.rename(str(conversation_id), body.title)


class TitleBody(BaseModel):
    model: str | None = Field(default=None, min_length=1, max_length=200)


@router.post("/conversations/{conversation_id}/title")
def generate_title(conversation_id: UUID, body: TitleBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.agent.generate_title(str(conversation_id), body.model)


@router.post("/conversations/{conversation_id}/suggestions")
def suggestions(conversation_id: UUID, c: Container = Depends(get_container)) -> dict[str, Any]:
    return {"items": c.agent.suggestions(str(conversation_id))}


class ChatBody(BaseModel):
    request_id: UUID
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=8000)]


@router.post("/conversations/{conversation_id}/messages")
def chat(conversation_id: UUID, body: ChatBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.agent.chat(str(conversation_id), str(body.request_id), body.text)


class ApplyBody(BaseModel):
    confirm: Literal[True] = Field(...)


@router.post("/turns/{turn_id}/apply")
def apply(turn_id: UUID, body: ApplyBody, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.agent.apply(str(turn_id))


@router.post("/turns/{turn_id}/discard")
def discard(turn_id: UUID, c: Container = Depends(get_container)) -> dict[str, Any]:
    return c.agent.discard(str(turn_id))
