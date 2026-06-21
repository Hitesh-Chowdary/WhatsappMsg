import React, { useState, useEffect, useRef, useCallback } from 'react';
import FlowBuilder from './components/FlowBuilder';

const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "http://localhost:8000" : "";
const RECORDS_PER_PAGE = 15;

function App() {
  // Auth State
  const [token, setToken] = useState(localStorage.getItem('jwt_token') || null);
  const [currentUser, setCurrentUser] = useState(localStorage.getItem('currentUser') || null);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // Stats State
  const [stats, setStats] = useState({
    total: 0,
    sent: 0,
    unsent: 0,
    read: 0,
    failed: 0,
    interested: 0,
    not_interested: 0
  });

  // Authenticated Fetch Wrapper
  const authFetch = useCallback(async (url, options = {}) => {
    const headers = {
      ...options.headers,
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    };
    
    try {
      const res = await fetch(url, { ...options, headers });
      if (res.status === 401) {
        localStorage.removeItem('jwt_token');
        setToken(null);
        triggerToast("Session expired or unauthorized. Please log in.", "error");
      }
      return res;
    } catch (err) {
      console.error("API request failed:", err);
      throw err;
    }
  }, [token]);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!loginUsername.trim() || !loginPassword.trim()) {
      setLoginError("Please enter both username and password.");
      return;
    }
    setLoginLoading(true);
    setLoginError('');
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: loginUsername,
          password: loginPassword
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || "Invalid credentials.");
      }
      
      localStorage.setItem('jwt_token', data.access_token);
      localStorage.setItem('currentUser', data.username || loginUsername);
      setToken(data.access_token);
      setCurrentUser(data.username || loginUsername);
      triggerToast("Logged in successfully.", "success");
    } catch (err) {
      setLoginError(err.message || "Failed to connect to the authentication server.");
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('jwt_token');
    localStorage.removeItem('currentUser');
    setToken(null);
    setCurrentUser(null);
    setLoginUsername('');
    setLoginPassword('');
    triggerToast("Logged out successfully.", "info");
  };

  // Records and Grid State
  const [records, setRecords] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [dispatchFilter, setDispatchFilter] = useState('all'); // 'all', 'unsent', 'sent', 'failed'
  const [deliveryFilter, setDeliveryFilter] = useState('all'); // 'all', 'undelivered', 'delivered'
  const [readFilter, setReadFilter] = useState('all'); // 'all', 'not_read', 'read'
  const [responseFilter, setResponseFilter] = useState('all'); // 'all', 'no_response', 'interested', 'not_interested'
  const [search, setSearch] = useState('');
  const [gridLoading, setGridLoading] = useState(true);
  const [gridError, setGridError] = useState('');
  const [branchFilter, setBranchFilter] = useState('all');
  const [pipelineTagFilter, setPipelineTagFilter] = useState('all');
  const [pendingNotesFilter, setPendingNotesFilter] = useState(false);
  const [branches, setBranches] = useState([]);
  const [selectedRecordIds, setSelectedRecordIds] = useState([]);


  // Custom Confirm Modal State
  const [confirmModal, setConfirmModal] = useState({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: null
  });

  const closeConfirmModal = () => {
    setConfirmModal(prev => ({ ...prev, isOpen: false }));
  };

  const isRecordEligibleForBulk = (rec) => {
    const campaignStatus = (rec.campaign_status || '').toLowerCase();
    const deliveryStatus = (rec.delivery_status || '').toLowerCase();
    const response = (rec.parent_response || '').toLowerCase();
    
    // Confirmed interested parents are excluded from bulk outreach
    if (response === 'interested') return false;
    
    // Unsent, failed, or not interested parents are eligible
    return (
      campaignStatus === 'pending' || 
      campaignStatus === 'failed' || 
      deliveryStatus === 'unsent' || 
      deliveryStatus === 'failed' ||
      response === 'not interested'
    );
  };

  // Template State
  const [templateText, setTemplateText] = useState('');
  const [mediaType, setMediaType] = useState('none'); // 'none', 'image', 'document'
  const [mediaUrl, setMediaUrl] = useState(null);
  const [mediaFilename, setMediaFilename] = useState('');
  const [mediaUploading, setMediaUploading] = useState(false);
  const [mediaFileMissing, setMediaFileMissing] = useState(false);
  const [templatesList, setTemplatesList] = useState([]);
  const [selectedTemplateName, setSelectedTemplateName] = useState('');
  const [templateFilter, setTemplateFilter] = useState('all');
  const [saveStatus, setSaveStatus] = useState('synced'); // synced, unsaved, saving
  const [showAddTemplateInput, setShowAddTemplateInput] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [addingTemplate, setAddingTemplate] = useState(false);

  // Uploader State
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatusText, setUploadStatusText] = useState('');
  const [parsedColumns, setParsedColumns] = useState([]);



  // Chat State
  const [activeView, setActiveView] = useState('outreach'); // 'outreach' or 'chat'
  const [chatsList, setChatsList] = useState([]);
  const [activeChatRecordId, setActiveChatRecordId] = useState(null);
  const [chatHistory, setChatHistory] = useState([]);
  const [typedMessage, setTypedMessage] = useState('');
  const [chatSearchText, setChatSearchText] = useState('');
  const [chatBranchFilter, setChatBranchFilter] = useState('all');
  const [mobileActiveSubView, setMobileActiveSubView] = useState('list'); // 'list', 'thread', 'rules'
  const [rulesList, setRulesList] = useState([]);
  const [newRuleKeyword, setNewRuleKeyword] = useState('');
  const [newRuleReply, setNewRuleReply] = useState('');
  const [sendingChat, setSendingChat] = useState(false);
  const [savingRule, setSavingRule] = useState(false);
  const [activeChatSubTab, setActiveChatSubTab] = useState('chat'); // 'chat' or 'notes'
  const [chatNotes, setChatNotes] = useState([]);
  const [newNoteText, setNewNoteText] = useState('');
  const [addingNote, setAddingNote] = useState(false);
  const [chatSession, setChatSession] = useState({ active: false, expires_at: null, time_remaining_seconds: 0 });
  const [selectedChatTemplate, setSelectedChatTemplate] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [reminders, setReminders] = useState([]);

  const [secondsLeft, setSecondsLeft] = useState(0);

  useEffect(() => {
    setSecondsLeft(chatSession.time_remaining_seconds || 0);
  }, [chatSession.time_remaining_seconds]);

  useEffect(() => {
    if (!chatSession.active || secondsLeft <= 0) return;

    const timer = setInterval(() => {
      setSecondsLeft(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          setChatSession(curr => ({ ...curr, active: false }));
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [chatSession.active, secondsLeft]);

  const formatSecondsToHMS = (totalSeconds) => {
    if (!totalSeconds || totalSeconds <= 0) return "00:00:00";
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    
    const pad = (num) => String(num).padStart(2, '0');
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  };

  // --- Chat & Auto-Reply API Handlers ---
  
  const fetchReminders = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/reminders`);
      if (res.ok) {
        const data = await res.json();
        setReminders(data);
      }
    } catch (err) {
      console.error("Error fetching reminders:", err);
    }
  };

  const playChime = () => {
    try {
      const audio = new Audio("https://assets.mixkit.co/active_storage/sfx/2869/2869-84.wav");
      audio.volume = 0.45;
      audio.play().catch(e => console.log("Audio autoplay prevented by browser. Interaction required first."));
    } catch (err) {
      console.error("Failed to play notification chime:", err);
    }
  };

  const fetchRecentChats = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/chat/recent`);
      if (res.ok) {
        const data = await res.json();
        setChatsList(prev => {
          let shouldPlay = false;
          data.forEach(newChat => {
            const oldChat = prev.find(c => c.record.id === newChat.record.id);
            const newMsg = newChat.last_message;
            
            // Play sound if a new message arrives from parent
            if (newMsg && newMsg.sender === 'parent') {
              if (!oldChat || !oldChat.last_message || oldChat.last_message.id !== newMsg.id) {
                shouldPlay = true;
              }
            }
            
            // Play sound if parent response transitions to "Counselor Needed"
            if (newChat.record.parent_response === 'Counselor Needed') {
              if (!oldChat || oldChat.record.parent_response !== 'Counselor Needed') {
                shouldPlay = true;
              }
            }
          });
          
          if (shouldPlay) {
            playChime();
          }
          return data;
        });
      }
    } catch (err) {
      console.error("Error fetching recent chats:", err);
    }
  };
  const handleUpdateTag = async (recordId, newTag) => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/records/${recordId}/tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipeline_tag: newTag })
      });
      if (res.ok) {
        triggerToast(`Pipeline tag updated to ${newTag}`, "success");
        
        const updatedParentResponse = newTag === 'Not Interested' ? 'Not Interested' 
                                    : newTag === 'Interested' ? 'Interested' 
                                    : null;

        // Update tag in chatsList state
        setChatsList(prev => prev.map(c => {
          if (c.record.id === recordId) {
            const updatedRec = { ...c.record, pipeline_tag: newTag };
            if (updatedParentResponse) {
              updatedRec.parent_response = updatedParentResponse;
            }
            return { ...c, record: updatedRec };
          }
          return c;
        }));
        // Update tag in records grid list state
        setRecords(prev => prev.map(r => {
          if (r.id === recordId) {
            const updatedRec = { ...r, pipeline_tag: newTag };
            if (updatedParentResponse) {
              updatedRec.parent_response = updatedParentResponse;
            }
            return updatedRec;
          }
          return r;
        }));
        fetchReminders();
      } else {
        triggerToast("Failed to update pipeline tag.", "error");
      }
    } catch (err) {
      console.error("Error updating tag:", err);
      triggerToast("Failed to update pipeline tag.", "error");
    }
  };

  const fetchChatHistory = async (recordId) => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/chat/history/${recordId}`);
      if (res.ok) {
        const data = await res.json();
        setChatHistory(data.messages || []);
        setChatSession(data.session || { active: false, expires_at: null, time_remaining_seconds: 0 });
      }
    } catch (err) {
      console.error("Error fetching chat history:", err);
    }
  };

  const fetchChatNotes = async (recordId) => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/records/${recordId}/notes`);
      if (res.ok) {
        const data = await res.json();
        setChatNotes(data);
      }
    } catch (err) {
      console.error("Error fetching notes:", err);
    }
  };

  const addChatNote = async () => {
    if (!newNoteText.trim() || !activeChatRecordId) return;
    setAddingNote(true);
    try {
      const res = await authFetch(`${API_BASE}/api/v1/records/${activeChatRecordId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note_text: newNoteText })
      });
      if (res.ok) {
        const data = await res.json();
        setChatNotes(prev => [data.note, ...prev]);
        setNewNoteText('');
        // Increment unresolved counts dynamically
        setRecords(prev => prev.map(rec => rec.id === activeChatRecordId ? { ...rec, unresolved_notes_count: (rec.unresolved_notes_count || 0) + 1 } : rec));
        setChatsList(prev => prev.map(c => c.record.id === activeChatRecordId ? { ...c, record: { ...c.record, unresolved_notes_count: (c.record.unresolved_notes_count || 0) + 1 } } : c));
        triggerToast("Note added successfully.", "success");
      } else {
        triggerToast("Failed to add internal note.", "error");
      }
    } catch (err) {
      console.error("Error adding note:", err);
      triggerToast("Failed to add internal note.", "error");
    } finally {
      setAddingNote(false);
    }
  };

  const resolveChatNote = async (noteId) => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/notes/${noteId}/resolve`, {
        method: 'POST'
      });
      if (res.ok) {
        setChatNotes(prev => prev.map(note => note.id === noteId ? { ...note, resolved: true } : note));
        // Decrement unresolved counts dynamically
        setRecords(prev => prev.map(rec => rec.id === activeChatRecordId ? { ...rec, unresolved_notes_count: Math.max(0, (rec.unresolved_notes_count || 1) - 1) } : rec));
        setChatsList(prev => prev.map(c => c.record.id === activeChatRecordId ? { ...c, record: { ...c.record, unresolved_notes_count: Math.max(0, (c.record.unresolved_notes_count || 1) - 1) } } : c));
        triggerToast("Note marked as resolved.", "success");
      } else {
        triggerToast("Failed to resolve note.", "error");
      }
    } catch (err) {
      console.error("Error resolving note:", err);
      triggerToast("Failed to resolve note.", "error");
    }
  };

  const sendManualMessage = async () => {
    if (!typedMessage.trim() || !activeChatRecordId) return;
    setSendingChat(true);
    try {
      const res = await authFetch(`${API_BASE}/api/v1/chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          record_id: activeChatRecordId,
          message_text: typedMessage
        })
      });
      const data = await res.json();
      if (res.ok) {
        setTypedMessage('');
        setChatHistory(prev => [...prev, data.message]);
        fetchRecentChats();
      } else {
        triggerToast(data.detail || "Failed to send message.", "error");
      }
    } catch (err) {
      triggerToast("Error sending message.", "error");
      console.error(err);
    } finally {
      setSendingChat(false);
    }
  };

  const sendManualTemplateMessage = async () => {
    if (!selectedChatTemplate || !activeChatRecordId) return;
    setSendingChat(true);
    try {
      const res = await authFetch(`${API_BASE}/api/v1/chat/send-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          record_id: activeChatRecordId,
          template_name: selectedChatTemplate
        })
      });
      const data = await res.json();
      if (res.ok) {
        setSelectedChatTemplate('');
        setChatHistory(prev => [...prev, data.message]);
        setForceFreeForm(false);
        fetchRecentChats();
        fetchChatHistory(activeChatRecordId);
        triggerToast("Template sent successfully!", "success");
      } else {
        triggerToast(data.detail || "Failed to send template.", "error");
      }
    } catch (err) {
      triggerToast("Error sending template.", "error");
      console.error(err);
    } finally {
      setSendingChat(false);
    }
  };

  const fetchAutoReplyRules = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/chat/rules`);
      if (res.ok) {
        const data = await res.json();
        setRulesList(data);
      }
    } catch (err) {
      console.error("Error fetching rules:", err);
    }
  };

  const saveAutoReplyRule = async () => {
    if (!newRuleKeyword.trim() || !newRuleReply.trim()) {
      triggerToast("Keyword and reply text cannot be empty.", "error");
      return;
    }
    setSavingRule(true);
    try {
      const res = await authFetch(`${API_BASE}/api/v1/chat/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword: newRuleKeyword,
          reply_text: newRuleReply
        })
      });
      if (res.ok) {
        setNewRuleKeyword('');
        setNewRuleReply('');
        triggerToast("Auto-reply rule saved.", "success");
        fetchAutoReplyRules();
      } else {
        const data = await res.json();
        triggerToast(data.detail || "Failed to save rule.", "error");
      }
    } catch (err) {
      triggerToast("Error saving rule.", "error");
      console.error(err);
    } finally {
      setSavingRule(false);
    }
  };

  const deleteAutoReplyRule = async (ruleId) => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/chat/rules/${ruleId}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        triggerToast("Auto-reply rule deleted.", "success");
        fetchAutoReplyRules();
      } else {
        triggerToast("Failed to delete rule.", "error");
      }
    } catch (err) {
      triggerToast("Error deleting rule.", "error");
      console.error(err);
    }
  };

  // Fetch chats and rules when switching to Chat View
  useEffect(() => {
    if (!token || activeView !== 'chat') return;
    
    fetchRecentChats();
    fetchAutoReplyRules();
    
    const chatsInterval = setInterval(() => {
      fetchRecentChats();
    }, 8000);
    
    return () => clearInterval(chatsInterval);
  }, [token, activeView]);

  // Set up polling for active chat history if one is selected
  useEffect(() => {
    if (!token || activeView !== 'chat' || !activeChatRecordId) return;
    
    fetchChatHistory(activeChatRecordId);
    
    const historyInterval = setInterval(() => {
      fetchChatHistory(activeChatRecordId);
    }, 4000);
    
    return () => clearInterval(historyInterval);
  }, [token, activeView, activeChatRecordId]);

  // Notifications State
  const [toasts, setToasts] = useState([]);

  // Refs for upload and search debounce
  const fileInputRef = useRef(null);
  const searchTimeoutRef = useRef(null);
  const logsEndRef = useRef(null);

  // ----------------------------------------------------
  // LIFECYCLE & POLLING
  // ----------------------------------------------------
  // Keep latest filter, search, page state in a ref to avoid stale closures in the polling interval
  const pollingStateRef = useRef({ currentPage, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter, templateFilter, selectedTemplateName, pipelineTagFilter, pendingNotesFilter });
  useEffect(() => {
    pollingStateRef.current = { currentPage, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter, templateFilter, selectedTemplateName, pipelineTagFilter, pendingNotesFilter };
  }, [currentPage, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter, templateFilter, selectedTemplateName, pipelineTagFilter, pendingNotesFilter]);

  useEffect(() => {
    if (!token) return;
    
    // Initial fetch
    fetchStats(selectedTemplateName);
    fetchTemplatesList(true);
    fetchBranches();
    fetchReminders();
    fetchRecords(1, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter, templateFilter, pipelineTagFilter, pendingNotesFilter);

    // Poll statistics and grid periodically to pick up async background sends
    const interval = setInterval(() => {
      fetchStats(pollingStateRef.current.selectedTemplateName);
      fetchBranches();
      fetchReminders();
      fetchRecords(
        pollingStateRef.current.currentPage, 
        pollingStateRef.current.dispatchFilter, 
        pollingStateRef.current.deliveryFilter, 
        pollingStateRef.current.readFilter, 
        pollingStateRef.current.responseFilter, 
        pollingStateRef.current.search, 
        pollingStateRef.current.branchFilter, 
        pollingStateRef.current.templateFilter,
        pollingStateRef.current.pipelineTagFilter,
        pollingStateRef.current.pendingNotesFilter,
        false
      ); // silent refresh without full loader
    }, 6000);

    return () => clearInterval(interval);
  }, [token]);

  // Handle stats reload when selected template changes
  useEffect(() => {
    if (!token) return;
    fetchStats(selectedTemplateName);
  }, [selectedTemplateName, token]);

  // Cascading dependency handlers
  const handleDispatchFilterChange = (val) => {
    setDispatchFilter(val);
    if (val !== 'sent') {
      setDeliveryFilter('all');
      setReadFilter('all');
      setResponseFilter('all');
    }
  };

  const handleDeliveryFilterChange = (val) => {
    setDeliveryFilter(val);
    if (val !== 'delivered') {
      setReadFilter('all');
      setResponseFilter('all');
    }
  };

  const handleReadFilterChange = (val) => {
    setReadFilter(val);
    if (val !== 'read') {
      setResponseFilter('all');
    }
  };

  // Handle filter changes
  useEffect(() => {
    if (!token) return;
    setCurrentPage(1);
    fetchRecords(1, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter, templateFilter, pipelineTagFilter, pendingNotesFilter);
  }, [dispatchFilter, deliveryFilter, readFilter, responseFilter, branchFilter, templateFilter, pipelineTagFilter, pendingNotesFilter, token]);

  // Handle search changes with 300ms debounce
  useEffect(() => {
    if (!token) return;
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    
    searchTimeoutRef.current = setTimeout(() => {
      setCurrentPage(1);
      fetchRecords(1, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter, templateFilter, pipelineTagFilter, pendingNotesFilter);
    }, 300);

    return () => clearTimeout(searchTimeoutRef.current);
  }, [search, token]);

  // Reset selected checkboxes on filter/search or page change
  useEffect(() => {
    setSelectedRecordIds([]);
  }, [dispatchFilter, deliveryFilter, readFilter, responseFilter, branchFilter, templateFilter, pipelineTagFilter, pendingNotesFilter, search, currentPage]);

  // Scroll sandbox logs to bottom


  // Trigger Excel download of filtered results
  const handleExportExcel = async () => {
    const params = new URLSearchParams();
    
    // Formulate parameters identical to fetchRecords
    if (dispatchFilter === 'unsent') {
      params.append('campaign_status', 'Pending');
    } else if (dispatchFilter === 'failed') {
      params.append('campaign_status', 'Failed');
    } else if (dispatchFilter === 'sent') {
      params.append('campaign_status', 'Sent');
      
      if (deliveryFilter === 'undelivered') {
        params.append('delivery_status', 'undelivered');
      } else if (deliveryFilter === 'delivered') {
        if (readFilter === 'not_read') {
          params.append('delivery_status', 'not_read');
        } else if (readFilter === 'read') {
          if (responseFilter === 'no_response') {
            params.append('parent_response', 'No Response');
            params.append('delivery_status', 'read');
          } else if (responseFilter === 'interested') {
            params.append('parent_response', 'Interested');
            params.append('delivery_status', 'read');
          } else if (responseFilter === 'not_interested') {
            params.append('parent_response', 'Not Interested');
            params.append('delivery_status', 'read');
          } else {
            params.append('delivery_status', 'read');
          }
        } else {
          params.append('delivery_status', 'delivered');
        }
      }
    }
    
    if (search.trim()) {
      params.append('search', search.trim());
    }
    
    if (branchFilter && branchFilter !== 'all') {
      params.append('branch', branchFilter);
    }

    if (templateFilter && templateFilter !== 'all') {
      params.append('template', templateFilter);
    }
    
    try {
      triggerToast("Generating Excel export...", "info");
      const res = await authFetch(`${API_BASE}/api/v1/records/export?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to generate export file from server.");
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `filtered_contacts_${new Date().toISOString().split('T')[0]}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      triggerToast("Excel export downloaded successfully.", "success");
    } catch (err) {
      console.error(err);
      triggerToast(err.message || "Failed to export Excel.", "error");
    }
  };

  // ----------------------------------------------------

  // TOAST ALERTS SYSTEM
  // ----------------------------------------------------
  const triggerToast = (message, type = 'info') => {
    const id = Date.now() + Math.random().toString(36).substr(2, 5);
    setToasts(prev => [...prev, { id, message, type }]);
    
    // Auto dismiss after 4 seconds
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };

  const removeToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };



  // ----------------------------------------------------
  // API CALLS
  // ----------------------------------------------------

  // Fetch Dashboard aggregate statistics
  const fetchStats = async (tmpl = null) => {
    try {
      const url = tmpl ? `${API_BASE}/api/v1/stats?template=${encodeURIComponent(tmpl)}` : `${API_BASE}/api/v1/stats`;
      const res = await authFetch(url);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setStats(data);
    } catch (err) {
      console.error("Failed to load statistics counters.");
    }
  };



  // Fetch unique academic branches present in database
  const fetchBranches = async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/branches`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setBranches(data);
    } catch (err) {
      console.error("Failed to load academic branches.");
    }
  };

  // Fetch paginated grid records
  const fetchRecords = async (page, dispatchF, deliveryF, readF, responseF, searchTerm, branchF, templateF, tagF = 'all', pendingNotesF = false, showLoader = true) => {
    // If showLoader is passed as false in the 10th or 11th position, we adjust.
    // To handle calls where pendingNotesF is omitted but showLoader is passed as the 10th parameter:
    let actualPendingNotes = pendingNotesF;
    let actualShowLoader = showLoader;
    if (typeof pendingNotesF === 'boolean' && showLoader === undefined) {
      // If only 10 arguments are passed and the 10th is a boolean, it might be showLoader.
      // But we always pass 11 arguments from our calls, so this is just for safety.
      actualShowLoader = pendingNotesF;
      actualPendingNotes = false;
    }
    
    if (actualShowLoader) setGridLoading(true);
    
    const params = new URLSearchParams();
    params.append('page', page);
    params.append('limit', RECORDS_PER_PAGE);
    
    if (searchTerm.trim()) params.append('search', searchTerm.trim());
    
    if (branchF && branchF !== 'all') {
      params.append('branch', branchF);
    }

    if (templateF && templateF !== 'all') {
      params.append('template', templateF);
    }

    if (tagF && tagF !== 'all') {
      params.append('pipeline_tag', tagF);
    }

    if (actualPendingNotes) {
      params.append('has_unresolved_notes', 'true');
    }

    // Level 1: Dispatch
    if (dispatchF === 'unsent') {
      params.append('campaign_status', 'Pending');
    } else if (dispatchF === 'failed') {
      params.append('campaign_status', 'Failed');
    } else if (dispatchF === 'sent') {
      params.append('campaign_status', 'Sent');
      
      // Level 2: Delivery
      if (deliveryF === 'undelivered') {
        params.append('delivery_status', 'undelivered');
      } else if (deliveryF === 'delivered') {
        // Level 3: Read Status
        if (readF === 'not_read') {
          params.append('delivery_status', 'not_read');
        } else if (readF === 'read') {
          // Level 4: Response
          if (responseF === 'no_response') {
            params.append('parent_response', 'No Response');
            params.append('delivery_status', 'read');
          } else if (responseF === 'interested') {
            params.append('parent_response', 'Interested');
            params.append('delivery_status', 'read');
          } else if (responseF === 'not_interested') {
            params.append('parent_response', 'Not Interested');
            params.append('delivery_status', 'read');
          } else {
            params.append('delivery_status', 'read');
          }
        } else {
          params.append('delivery_status', 'delivered');
        }
      }
    }

    try {
      const res = await authFetch(`${API_BASE}/api/v1/records?${params.toString()}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      
      setRecords(data.records);
      setTotalCount(data.total);
      setCurrentPage(data.page);
      setTotalPages(data.pages);
      setGridError('');
    } catch (err) {
      console.error(err);
      setGridError("Failed to retrieve admission details from the database.");
    } finally {
      if (showLoader) setGridLoading(false);
    }
  };

  // Fetch templates list
  const fetchTemplatesList = async (selectActive = false) => {
    try {
      const res = await authFetch(`${API_BASE}/api/v1/templates`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setTemplatesList(data);
      
      if (selectActive) {
        const active = data.find(t => t.is_active);
        if (active) {
          setSelectedTemplateName(active.template_name);
          setTemplateFilter(active.template_name);
          setTemplateText(active.template_text);
          setMediaType(active.media_type || 'none');
          setMediaUrl(active.media_url || null);
          setMediaFileMissing(active.media_file_missing || false);
          if (active.media_url) {
            const parts = active.media_url.split('/');
            setMediaFilename(parts[parts.length - 1]);
          } else {
            setMediaFilename('');
          }
        } else if (data.length > 0) {
          setSelectedTemplateName(data[0].template_name);
          setTemplateFilter(data[0].template_name);
          setTemplateText(data[0].template_text);
          setMediaType(data[0].media_type || 'none');
          setMediaUrl(data[0].media_url || null);
          setMediaFileMissing(data[0].media_file_missing || false);
          if (data[0].media_url) {
            const parts = data[0].media_url.split('/');
            setMediaFilename(parts[parts.length - 1]);
          } else {
            setMediaFilename('');
          }
        }
      }
    } catch (err) {
      console.error("Error loading templates list:", err);
    }
  };

  const handleTemplateChange = async (name) => {
    setSelectedTemplateName(name);
    setTemplateFilter(name);
    const tmpl = templatesList.find(t => t.template_name === name);
    if (tmpl) {
      setTemplateText(tmpl.template_text);
      setMediaType(tmpl.media_type || 'none');
      setMediaUrl(tmpl.media_url || null);
      setMediaFileMissing(tmpl.media_file_missing || false);
      if (tmpl.media_url) {
        const parts = tmpl.media_url.split('/');
        setMediaFilename(parts[parts.length - 1]);
      } else {
        setMediaFilename('');
      }
      setSaveStatus('synced');
      
      try {
        await authFetch(`${API_BASE}/api/v1/templates/active`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ template_name: name })
        });
        setTemplatesList(prev => prev.map(t => ({
          ...t,
          is_active: t.template_name === name
        })));
        triggerToast(`Active template switched to ${name}`, "success");
        fetchStats(name);
      } catch (err) {
        console.error("Error updating active template:", err);
        triggerToast("Failed to update active template selection.", "error");
      }
    }
  };

  const [syncingTemplates, setSyncingTemplates] = useState(false);
  const handleSyncTemplates = async () => {
    setSyncingTemplates(true);
    triggerToast("Syncing approved templates from Meta...", "info");
    try {
      const res = await authFetch(`${API_BASE}/api/v1/templates/sync`, {
        method: 'POST'
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to sync templates.");
      
      triggerToast(data.message || "Templates synced successfully.", "success");
      await fetchTemplatesList(true);
    } catch (err) {
      console.error(err);
      triggerToast(err.message || "Error syncing templates.", "error");
    } finally {
      setSyncingTemplates(false);
    }
  };

  const handleAddTemplate = async () => {
    const name = newTemplateName.trim();
    if (!name) {
      triggerToast("Please enter a template name.", "error");
      return;
    }
    
    setAddingTemplate(true);
    triggerToast(`Fetching template '${name}' from Meta...`, "info");
    try {
      const res = await authFetch(`${API_BASE}/api/v1/templates/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_name: name })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to add template.");
      
      triggerToast(data.message || `Template '${name}' added successfully.`, "success");
      setNewTemplateName('');
      setShowAddTemplateInput(false);
      
      // Refresh templates list and select this newly added one
      await fetchTemplatesList(false);
      const t = data.template;
      setSelectedTemplateName(t.template_name);
      setTemplateFilter(t.template_name);
      setTemplateText(t.template_text);
      setMediaType(t.media_type || 'none');
      setMediaUrl(t.media_url || null);
      setMediaFileMissing(t.media_file_missing || false);
      if (t.media_url) {
        const parts = t.media_url.split('/');
        setMediaFilename(parts[parts.length - 1]);
      } else {
        setMediaFilename('');
      }
      setSaveStatus('synced');
      fetchStats(t.template_name);
    } catch (err) {
      console.error(err);
      triggerToast(err.message || "Error adding template.", "error");
    } finally {
      setAddingTemplate(false);
    }
  };

  // Save template text
  const handleSaveTemplate = async () => {
    if (!templateText.trim()) {
      triggerToast("Template text cannot be empty.", "error");
      return;
    }
    setSaveStatus('saving');
    try {
      const res = await authFetch(`${API_BASE}/api/v1/template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          template_name: selectedTemplateName,
          template_text: templateText,
          media_type: mediaType,
          media_url: mediaUrl
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to save template.");
      
      // Update local templates list
      setTemplatesList(prev => prev.map(t => t.template_name === selectedTemplateName ? {
        ...t,
        template_text: data.template_text,
        media_type: data.media_type,
        media_url: data.media_url,
        media_file_missing: false
      } : t));
      
      setSaveStatus('synced');
      triggerToast("Template saved successfully.", "success");
    } catch (err) {
      setSaveStatus('unsaved');
      triggerToast(err.message, "error");
    }
  };

  // Upload template media file
  const handleMediaUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    setMediaUploading(true);
    try {
      const res = await authFetch(`${API_BASE}/api/v1/template/upload-media`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Media upload failed.");

      setMediaUrl(data.media_url);
      setMediaFilename(file.name);
      setMediaFileMissing(false);
      setSaveStatus('unsaved');
      triggerToast("Media file uploaded successfully.", "success");
    } catch (err) {
      triggerToast(err.message, "error");
    } finally {
      setMediaUploading(false);
      e.target.value = '';
    }
  };

  // Upload spreadsheet
  const handleFileUpload = async (file) => {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext !== 'xlsx' && ext !== 'csv') {
      triggerToast("Invalid format. Please upload an Excel (.xlsx) or CSV (.csv) file.", "error");
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    setUploading(true);
    setUploadProgress(0);
    setUploadStatusText(`Uploading file: ${file.name}...`);

    // Animate progress bar loader
    let width = 0;
    const progressInterval = setInterval(() => {
      if (width < 90) {
        width += 15;
        setUploadProgress(width);
      }
    }, 80);

    try {
      const res = await authFetch(`${API_BASE}/api/v1/upload`, {
        method: 'POST',
        body: formData
      });
      clearInterval(progressInterval);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Upload ingestion failed.");

      setUploadProgress(100);
      setUploadStatusText(`Success: ${data.message}`);
      triggerToast(data.message, "success");
      setParsedColumns(data.columns || []);

      setTimeout(() => {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
        refreshDashboard();
      }, 1500);

    } catch (err) {
      clearInterval(progressInterval);
      setUploadProgress(0);
      setUploadStatusText(`Ingestion Failed: ${err.message}`);
      triggerToast(err.message, "error");
      setTimeout(() => setUploading(false), 3000);
    }
  };

  // Launch broadcast campaign
  const handleLaunchBroadcast = async () => {
    setConfirmModal({
      isOpen: true,
      title: 'Launch Broadcast Campaign',
      message: 'Are you sure you want to launch the broadcast campaign? This will send outreach messages to all pending candidates in the database.',
      onConfirm: async () => {
        closeConfirmModal();
        try {
          const res = await authFetch(`${API_BASE}/api/v1/campaign/broadcast`, { method: 'POST' });
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || "Broadcast trigger failed.");

          if (data.status === 'ignored') {
            triggerToast(data.message, "info");
          } else {
            triggerToast(data.message, "success");
          }
          setTimeout(refreshDashboard, 1000);
        } catch (err) {
          triggerToast(err.message, "error");
        }
      }
    });
  };

  // Dispatch campaign to single contact
  const handleSendSingle = async (id) => {
    triggerToast("Dispatching single campaign request...", "info");
    try {
      const templateToSend = templateFilter === 'all' ? selectedTemplateName : templateFilter;
      const url = `${API_BASE}/api/v1/campaign/send-single/${id}${templateToSend ? `?template_name=${encodeURIComponent(templateToSend)}` : ''}`;
      const res = await authFetch(url, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Single sending failed.");
      
      triggerToast(data.message, "success");
      refreshDashboard();
    } catch (err) {
      triggerToast(err.message, "error");
    }
  };

  // Trigger bulk campaign messages
  const handleBulkSend = async () => {
    if (selectedRecordIds.length === 0) return;
    
    const eligibleRecords = records.filter(r => selectedRecordIds.includes(r.id) && r.parent_response !== 'Interested');
    const interestedCount = selectedRecordIds.length - eligibleRecords.length;
    
    if (eligibleRecords.length === 0) {
      triggerToast("No eligible candidates selected. Outreach is disabled for confirmed Interested parents.", "error");
      return;
    }
    
    let confirmMsg = `Are you sure you want to send outreach messages to ${eligibleRecords.length} selected candidate(s)?`;
    if (interestedCount > 0) {
      confirmMsg += ` (${interestedCount} confirmed Interested parent(s) will be automatically skipped to prevent spam.)`;
    }
    
    setConfirmModal({
      isOpen: true,
      title: 'Confirm Outreach Dispatch',
      message: confirmMsg,
      onConfirm: async () => {
        closeConfirmModal();
        triggerToast("Initiating bulk campaign dispatch...", "info");
        try {
          const templateToSend = templateFilter === 'all' ? selectedTemplateName : templateFilter;
          const res = await authFetch(`${API_BASE}/api/v1/campaign/send-bulk`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              record_ids: eligibleRecords.map(r => r.id),
              template_name: templateToSend
            })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || "Failed to trigger bulk dispatch.");
          
          triggerToast(data.message, "success");
          setSelectedRecordIds([]);
          setTimeout(refreshDashboard, 1000);
        } catch (err) {
          triggerToast(err.message, "error");
        }
      }
    });
  };



  // Reset uploader display
  const handleResetUploader = () => {
    setParsedColumns([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Helper refresh
  const refreshDashboard = () => {
    fetchStats();
    fetchRecords(
      pollingStateRef.current.currentPage, 
      pollingStateRef.current.dispatchFilter, 
      pollingStateRef.current.deliveryFilter, 
      pollingStateRef.current.readFilter, 
      pollingStateRef.current.responseFilter, 
      pollingStateRef.current.search, 
      pollingStateRef.current.branchFilter,
      pollingStateRef.current.templateFilter,
      pollingStateRef.current.pipelineTagFilter,
      pollingStateRef.current.pendingNotesFilter,
      false
    );
  };

  // ----------------------------------------------------
  // INTERACTIVE TEMPLATE PREVIEW HELPERS
  // ----------------------------------------------------
  const getTemplateFields = () => {
    const tmpl = templatesList.find(t => t.template_name === selectedTemplateName);
    if (!tmpl) return { required: [], missing: [] };
    
    const vars = tmpl.variable_names 
      ? tmpl.variable_names.split(',').map(v => v.trim()).filter(Boolean) 
      : [];
      
    if (vars.length === 0) {
      return { required: [], missing: [] };
    }
    
    const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    const missing = [];
    if (parsedColumns.length > 0) {
      const normalizedColumns = parsedColumns.map(c => normalize(c));
      
      vars.forEach(v => {
        const normV = normalize(v);
        
        // Define synonym groups for standard mapping
        const studentSynonyms = ['studentname', 'student', 'candidatename', 'candidate'];
        const parentSynonyms = ['parentname', 'parent', 'fathername', 'mothername', 'guardianname', 'guardian'];
        const branchSynonyms = ['selectedbranch', 'branch', 'course', 'selectedcourse', 'status', 'admissionstatus'];
        
        let found = normalizedColumns.includes(normV);
        
        if (!found) {
          if (studentSynonyms.includes(normV)) {
            found = normalizedColumns.some(c => studentSynonyms.includes(c));
          } else if (parentSynonyms.includes(normV)) {
            found = normalizedColumns.some(c => parentSynonyms.includes(c));
          } else if (branchSynonyms.includes(normV)) {
            found = normalizedColumns.some(c => branchSynonyms.includes(c));
          }
        }
        
        if (!found) {
          missing.push(v);
        }
      });
    }
    
    return { required: vars, missing };
  };

  const { required: requiredFields, missing: missingFields } = getTemplateFields();

  const renderLivePreviewText = () => {
    if (!templateText) {
      return <span className="text-muted">Type template text above...</span>;
    }
    
    let preview = escapeHTML(templateText);
    preview = preview.replace(/\[Parent Name\]/g, '<span class="var">Rohan Kumar</span>');
    preview = preview.replace(/\[Student Name\]/g, '<span class="var">Rajesh Kumar</span>');
    preview = preview.replace(/\[Selected Branch\]/g, '<span class="var">Computer Science</span>');
    preview = preview.replace(/\[Phone Number\]/g, '<span class="var">919876543210</span>');
    
    return <span dangerouslySetInnerHTML={{ __html: preview }} />;
  };

  const insertToken = (token) => {
    const editor = document.getElementById('template-editor-textarea');
    if (!editor) return;

    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const text = templateText;

    const newText = text.substring(0, start) + token + text.substring(end);
    setTemplateText(newText);
    setSaveStatus('unsaved');

    // Return focus to editor
    setTimeout(() => {
      editor.focus();
      editor.selectionStart = editor.selectionEnd = start + token.length;
    }, 0);
  };

  // ----------------------------------------------------
  // COMPONENT EVENT HANDLERS
  // ----------------------------------------------------
  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileUpload(e.dataTransfer.files[0]);
    }
  };



  // Helper helper
  const changePage = (dir) => {
    const target = currentPage + dir;
    if (target >= 1 && target <= totalPages) {
      setCurrentPage(target);
      fetchRecords(target, dispatchFilter, deliveryFilter, readFilter, responseFilter, search, branchFilter, templateFilter, pipelineTagFilter, pendingNotesFilter);
    }
  };

  const formatSessionTime = (seconds) => {
    if (!seconds || seconds <= 0) return "expired";
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hrs > 0) {
      return `${hrs}hr ${mins}m left`;
    }
    return `${mins}m left`;
  };

  // ----------------------------------------------------
  // HTML ESCAPE AND UTILITIES
  // ----------------------------------------------------
  function escapeHTML(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Calc read percentage rates
  const readRate = stats.sent > 0 ? Math.round((stats.read / stats.sent) * 100) : 0;

  if (!token) {
    return (
      <div className="login-screen-container">
        <div className="login-card">
          <div className="login-card-header">
            <div className="login-logo">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
              </svg>
            </div>
            <h2>Admin Portal</h2>
            <p>Sign in to access the admission engine</p>
          </div>

          {loginError && (
            <div className="login-error-alert">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <span>{loginError}</span>
            </div>
          )}

          <form onSubmit={handleLogin}>
            <div className="login-form-group">
              <label htmlFor="username">Username</label>
              <input
                id="username"
                type="text"
                className="login-input"
                placeholder="Enter username"
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
                disabled={loginLoading}
                required
              />
            </div>

            <div className="login-form-group">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                className="login-input"
                placeholder="Enter password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                disabled={loginLoading}
                required
              />
            </div>

            <button type="submit" className="login-button" disabled={loginLoading}>
              {loginLoading ? (
                <>Signing in...</>
              ) : (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
                    <polyline points="10 17 15 12 10 7"></polyline>
                    <line x1="15" y1="12" x2="3" y2="12"></line>
                  </svg>
                  Sign In
                </>
              )}
            </button>
          </form>
        </div>

        {/* Global notifications toaster container */}
        <div className="toast-container">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast toast-${toast.type} show`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ color: 'inherit', display: 'flex', alignItems: 'center' }}>
                  {toast.type === 'success' && (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
                  )}
                  {toast.type === 'error' && (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
                  )}
                  {toast.type === 'info' && (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                  )}
                </span>
                <span className="toast-content">{toast.message}</span>
              </div>
              <button onClick={() => removeToast(toast.id)} className="btn-toast-close">&times;</button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const getHeaderContent = () => {
    switch (activeView) {
      case 'outreach':
        return {
          meta: "Campaigns & Ingestion",
          title: "Outreach Dashboard",
          subtitle: "Upload student directories via Excel, trigger template broadcasts, and track real-time delivery conversion rates."
        };
      case 'chat':
        return {
          meta: "Live Support & Notes",
          title: "Live Chat & Counselor Inbox",
          subtitle: "Communicate directly with parents, review automated bot history, and manage internal counselor follow-up notes."
        };
      case 'bot-builder':
        return {
          meta: "Automation Engine",
          title: "Visual Auto-Bot Flow Builder",
          subtitle: "Design parent interactive response paths, configure button callbacks, and edit direct messaging scripts."
        };
      case 'reminders':
        return {
          meta: "Scheduled Reminders & Calls",
          title: "Scheduled Call Reminders",
          subtitle: "View and manage all parent requests for calls, including specific scheduled time slots."
        };
      default:
        return {
          meta: "Admissions Portal",
          title: "Admissions AI Engine",
          subtitle: "Manage parent communications and automated candidate engagement channels."
        };
    }
  };

  const header = getHeaderContent();

  return (
    <div className={`app-wrapper mobile-view-${mobileActiveSubView}`}>
      {/* 1. Left Sidebar Navigation */}
      <aside 
        className="app-sidebar"
        style={{ 
          width: isSidebarOpen ? '280px' : '72px',
          minWidth: isSidebarOpen ? '280px' : '72px',
          transition: 'width 0.2s cubic-bezier(0.4, 0, 0.2, 1), min-width 0.2s cubic-bezier(0.4, 0, 0.2, 1)'
        }}
      >
        <div 
          className="sidebar-header" 
          style={{ 
            display: 'flex', 
            justifyContent: isSidebarOpen ? 'space-between' : 'center', 
            alignItems: 'center', 
            padding: isSidebarOpen ? '0 1.5rem' : '0 0.5rem' 
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div 
              className="sidebar-logo" 
              style={{ cursor: isSidebarOpen ? 'default' : 'pointer' }} 
              onClick={() => !isSidebarOpen && setIsSidebarOpen(true)} 
              title={!isSidebarOpen ? "Expand Sidebar" : undefined}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
            </div>
            {isSidebarOpen && <span className="sidebar-brand-title">Admissions AI</span>}
          </div>
          {isSidebarOpen && (
            <button 
              onClick={() => setIsSidebarOpen(false)}
              title="Collapse Sidebar"
              style={{ 
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                color: 'var(--text-secondary)',
                fontSize: '1.1rem',
                display: 'flex',
                alignItems: 'center',
                padding: '0.25rem'
              }}
            >
              ⇤
            </button>
          )}
        </div>

        <nav className="sidebar-menu" style={{ padding: isSidebarOpen ? '1.5rem 0.75rem' : '1.5rem 0.5rem' }}>
          <button 
            className={`sidebar-menu-item ${activeView === 'outreach' ? 'active' : ''}`}
            onClick={() => setActiveView('outreach')}
            style={{ 
              justifyContent: isSidebarOpen ? 'flex-start' : 'center', 
              padding: isSidebarOpen ? '0.75rem 1rem' : '0.75rem 0' 
            }}
            title={!isSidebarOpen ? "Outreach Dashboard" : undefined}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
            </svg>
            {isSidebarOpen && <span>Outreach Dashboard</span>}
          </button>

          <button 
            className={`sidebar-menu-item ${activeView === 'chat' ? 'active' : ''}`}
            onClick={() => setActiveView('chat')}
            style={{ 
              justifyContent: isSidebarOpen ? 'flex-start' : 'center', 
              padding: isSidebarOpen ? '0.75rem 1rem' : '0.75rem 0' 
            }}
            title={!isSidebarOpen ? "Live Chat Support" : undefined}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
            {isSidebarOpen && <span>Live Chat Support</span>}
          </button>

          <button 
            className={`sidebar-menu-item ${activeView === 'bot-builder' ? 'active' : ''}`}
            onClick={() => setActiveView('bot-builder')}
            style={{ 
              justifyContent: isSidebarOpen ? 'flex-start' : 'center', 
              padding: isSidebarOpen ? '0.75rem 1rem' : '0.75rem 0' 
            }}
            title={!isSidebarOpen ? "Visual Bot Builder" : undefined}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="9" y1="3" x2="9" y2="21"></line>
              <line x1="9" y1="12" x2="21" y2="12"></line>
            </svg>
            {isSidebarOpen && <span>Visual Bot Builder</span>}
          </button>

          <button 
            className={`sidebar-menu-item ${activeView === 'reminders' ? 'active' : ''}`}
            onClick={() => setActiveView('reminders')}
            style={{ 
              justifyContent: isSidebarOpen ? 'flex-start' : 'center', 
              padding: isSidebarOpen ? '0.75rem 1rem' : '0.75rem 0',
              position: 'relative'
            }}
            title={!isSidebarOpen ? "Scheduled Reminders" : undefined}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="16" y1="2" x2="16" y2="6"></line>
              <line x1="8" y1="2" x2="8" y2="6"></line>
              <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
            {isSidebarOpen && <span>Scheduled Reminders</span>}
            {reminders.length > 0 && (
              <span className="badge-notification" style={{
                backgroundColor: 'var(--color-coral)',
                color: '#fff',
                borderRadius: '50%',
                minWidth: '18px',
                height: '18px',
                fontSize: '0.7rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 'bold',
                marginLeft: isSidebarOpen ? 'auto' : '0',
                position: isSidebarOpen ? 'static' : 'absolute',
                top: isSidebarOpen ? 'auto' : '4px',
                right: isSidebarOpen ? 'auto' : '4px',
                padding: '0 4px',
                boxShadow: '0 2px 4px rgba(239, 68, 68, 0.3)'
              }}>
                {reminders.length}
              </span>
            )}
          </button>
        </nav>

        <div className="sidebar-footer" style={{ padding: isSidebarOpen ? '1.25rem 1rem' : '1.25rem 0.5rem', alignItems: 'center' }}>
          <div className="sidebar-user-info" style={{ justifyContent: isSidebarOpen ? 'flex-start' : 'center', width: '100%', gap: isSidebarOpen ? '0.75rem' : '0' }}>
            <div className="sidebar-user-avatar" title={!isSidebarOpen ? "Admissions Staff (Administrator)" : undefined}>A</div>
            {isSidebarOpen && (
              <div className="sidebar-user-details">
                <span className="sidebar-user-name">Admissions Staff</span>
                <span className="sidebar-user-role">Administrator</span>
              </div>
            )}
          </div>

          <button 
            onClick={handleLogout} 
            className="btn btn-secondary btn-sidebar-logout"
            style={{ 
              justifyContent: isSidebarOpen ? 'flex-start' : 'center',
              padding: isSidebarOpen ? '0.5rem 1rem' : '0.5rem 0',
              marginTop: '0.75rem' 
            }}
            title={!isSidebarOpen ? "Sign Out" : undefined}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: isSidebarOpen ? '6.6px' : '0' }}>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
              <polyline points="16 17 21 12 16 7"></polyline>
              <line x1="21" y1="12" x2="9" y2="12"></line>
            </svg>
            {isSidebarOpen && "Sign Out"}
          </button>
        </div>
      </aside>

      {/* 2. Main Content View Area */}
      <main className="app-content">
        
        {/* Header Title Bar */}
        <header className="dashboard-header">
          <div className="header-titles">
            <span className="header-meta">{header.meta}</span>
            <h1>{header.title}</h1>
            <p className="subtitle">{header.subtitle}</p>
          </div>
        </header>

        <div style={{ display: activeView === 'outreach' ? 'flex' : 'none', flexDirection: 'column', gap: '2rem' }}>
            {/* Analytics statistical counters grid */}
            <section className="analytics-grid">
          <div className="stat-card">
            <div className="stat-icon icon-blue">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                <circle cx="9" cy="7" r="4"></circle>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-label">Total Uploaded</span>
              <h3 className="stat-value">{stats.total.toLocaleString()}</h3>
              <p className="stat-desc">Parents in database</p>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon icon-purple">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-label">Campaign Sent</span>
              <h3 className="stat-value">{stats.sent.toLocaleString()}</h3>
              <p className="stat-desc">{stats.unsent.toLocaleString()} unsent/pending</p>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon icon-amber">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-label">Read / Seen</span>
              <h3 className="stat-value">{stats.read.toLocaleString()}</h3>
              <p className="stat-desc">{readRate}% read conversion</p>
            </div>
          </div>

          <div className="stat-card stat-highlight-emerald">
            <div className="stat-icon icon-emerald">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                <polyline points="22 4 12 14.01 9 11.01"></polyline>
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-label text-emerald">Interested</span>
              <h3 className="stat-value text-emerald">{stats.interested.toLocaleString()}</h3>
              <span className="stat-badge badge-glow-emerald">Action Required</span>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon icon-coral">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="15" y1="9" x2="9" y2="15"></line>
                <line x1="9" y1="9" x2="15" y2="15"></line>
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-label">Not Interested</span>
              <h3 className="stat-value">{stats.not_interested.toLocaleString()}</h3>
              <p className="stat-desc">Seats released</p>
            </div>
          </div>

          <div className="stat-card">
            <div className="stat-icon" style={{ backgroundColor: 'var(--color-coral-light)', border: '1px solid var(--color-coral-border)', color: 'var(--color-coral)' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
            </div>
            <div className="stat-content">
              <span className="stat-label">Delivery Failed</span>
              <h3 className="stat-value">{(stats.failed || 0).toLocaleString()}</h3>
              <p className="stat-desc">Requires manual retry</p>
            </div>
          </div>
        </section>

        {/* Interactive Funnel Analytics Panel */}
        <section className="glass-panel analytics-funnel-card" style={{ padding: '1.5rem', borderRadius: '12px', border: '1px solid var(--border-color)', backgroundColor: 'white' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
            <div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: '700', color: 'var(--color-text-dark)', margin: 0 }}>Interactive Conversion Funnel</h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', margin: '2px 0 0 0' }}>Track candidates from initial dispatch to successful enrollment</p>
            </div>
            <div style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem', borderRadius: '20px', backgroundColor: 'var(--color-blue-light)', color: 'var(--color-blue)', fontWeight: '600' }}>
              Real-time Flow Analysis
            </div>
          </div>
          
          <div className="funnel-container" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {(() => {
              const baseValue = stats.sent || 1;
              const steps = [
                { label: "Sent Outreach Messages", value: stats.sent, color: "var(--color-purple)", desc: "Campaign broadcasts successfully dispatched" },
                { label: "Delivered to Device", value: stats.delivered || 0, color: "var(--color-blue)", desc: "Received on parent's phone" },
                { label: "Read / Opened", value: stats.read, color: "var(--color-amber)", desc: "Opened and viewed by recipient" },
                { label: "Replied / Inbound", value: stats.replied || 0, color: "var(--color-coral)", desc: "Engaged in conversation" },
                { label: "Interested Candidates", value: stats.interested, color: "var(--color-emerald)", desc: "Marked interested by counselor or bot" },
                { label: "Enrolled Students", value: stats.enrolled || 0, color: "#10b981", desc: "Successfully admitted to college" }
              ];
              
              return steps.map((step, idx) => {
                const prevStep = idx > 0 ? steps[idx - 1] : null;
                const prevValue = prevStep ? prevStep.value : baseValue;
                
                const overallPct = stats.sent > 0 ? ((step.value / stats.sent) * 100).toFixed(1) : '0.0';
                const stepPct = prevValue > 0 ? ((step.value / prevValue) * 100).toFixed(1) : '0.0';
                
                return (
                  <div key={idx} className="funnel-step" style={{ display: 'flex', alignItems: 'center', gap: '1rem', width: '100%', padding: '0.5rem', borderRadius: '8px' }}>
                    <div style={{ width: '180px', display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--color-text-dark)' }}>{step.label}</span>
                      <span style={{ fontSize: '0.7rem', color: 'var(--color-text-muted)' }}>{step.desc}</span>
                    </div>
                    <div style={{ flexGrow: 1, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <div style={{ flexGrow: 1, height: '18px', backgroundColor: '#f1f5f9', borderRadius: '9px', overflow: 'hidden', position: 'relative' }}>
                        <div style={{ 
                          width: `${Math.min(100, Math.max(0.5, (step.value / baseValue) * 100))}%`, 
                          height: '100%', 
                          backgroundColor: step.color,
                          borderRadius: '9px',
                          transition: 'width 0.6s ease'
                        }} />
                        <span style={{ 
                          position: 'absolute', 
                          left: '10px', 
                          top: '50%', 
                          transform: 'translateY(-50%)', 
                          fontSize: '0.7rem', 
                          fontWeight: '700', 
                          color: (step.value / baseValue) * 100 > 15 ? 'white' : 'var(--color-text-dark)'
                        }}>
                          {step.value.toLocaleString()}
                        </span>
                      </div>
                      <div style={{ width: '120px', display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                        <span style={{ color: 'var(--color-text-muted)' }}>
                          Step: <strong style={{ color: 'var(--color-text-dark)' }}>{stepPct}%</strong>
                        </span>
                        <span style={{ color: 'var(--color-text-muted)' }}>
                          Total: <strong style={{ color: 'var(--color-text-dark)' }}>{overallPct}%</strong>
                        </span>
                      </div>
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        </section>

        {/* File Ingestion & Campaign Control Cards */}
        <section className="control-center">
          
          {/* File Upload Panel (Left Side) */}
          <div className="glass-panel upload-panel">
            <div class="panel-header">
              <h4>Excel Ingestion Engine</h4>
            </div>

            {parsedColumns.length === 0 ? (
              <div 
                className={`drop-zone ${dragActive ? 'dragover' : ''}`}
                onDragEnter={handleDrag}
                onDragOver={handleDrag}
                onDragLeave={handleDrag}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current.click()}
              >
                <input 
                  type="file" 
                  ref={fileInputRef}
                  accept=".xlsx,.csv" 
                  className="hidden-input"
                  onChange={(e) => e.target.files[0] && handleFileUpload(e.target.files[0])}
                />
                <div className="drop-zone-content">
                  <svg className="upload-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="17 8 12 3 7 8"></polyline>
                    <line x1="12" y1="3" x2="12" y2="15"></line>
                  </svg>
                  <p className="upload-title">Drag & drop spreadsheet here</p>
                  <p className="upload-subtitle">Supports .xlsx or .csv up to 2,000 numbers</p>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={(e) => {e.stopPropagation(); fileInputRef.current.click();}}>Browse Files</button>
                </div>
              </div>
            ) : (
              <div className="columns-display-container">
                <div className="columns-display-header">
                  <h5>Spreadsheet Columns Parsed</h5>
                  <p className="columns-desc">The following headers were auto-mapped from your file:</p>
                </div>
                <div className="parsed-columns-list">
                  {parsedColumns.map((col, idx) => (
                    <span key={idx} className="column-pill">{col}</span>
                  ))}
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={handleResetUploader} style={{marginTop: 'auto', width: '100%'}}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="17 8 12 3 7 8"></polyline>
                    <line x1="12" y1="3" x2="12" y2="15"></line>
                  </svg>
                  Upload Another Spreadsheet
                </button>
              </div>
            )}

            {uploading && (
              <div className="upload-progress-container">
                <div className="progress-bar-bg">
                  <div className="progress-bar-fill" style={{ width: `${uploadProgress}%` }}></div>
                </div>
                <p className="progress-text">{uploadStatusText}</p>
              </div>
            )}
          </div>

          {/* Campaign Controls (Right Side - Customizable Template) */}
          <div className="glass-panel campaign-panel">
            <div className="panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
              <h4>Campaign Control Center</h4>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button 
                  onClick={() => setShowAddTemplateInput(!showAddTemplateInput)} 
                  className="btn btn-secondary btn-sm" 
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                >
                  ➕ Add Template
                </button>
                <button 
                  onClick={handleSyncTemplates} 
                  className="btn btn-secondary btn-sm" 
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                  disabled={syncingTemplates}
                >
                  {syncingTemplates ? 'Syncing...' : '🔄 Sync Templates'}
                </button>
              </div>
            </div>
            
            {showAddTemplateInput && (
              <div style={{
                padding: '0.75rem 1rem',
                borderBottom: '1px solid var(--border-color)',
                backgroundColor: 'rgba(255, 255, 255, 0.02)',
                display: 'flex',
                gap: '0.5rem',
                alignItems: 'center'
              }}>
                <input 
                  type="text" 
                  placeholder="Template Name (e.g. parent_outreach)" 
                  className="filter-select"
                  style={{ flex: 1, height: '32px', fontSize: '0.8rem' }}
                  value={newTemplateName}
                  onChange={(e) => setNewTemplateName(e.target.value)}
                  disabled={addingTemplate}
                />
                <button 
                  onClick={handleAddTemplate} 
                  className="btn btn-primary btn-sm"
                  style={{ height: '32px', fontSize: '0.75rem' }}
                  disabled={addingTemplate}
                >
                  {addingTemplate ? 'Adding...' : 'Fetch'}
                </button>
                <button 
                  onClick={() => { setShowAddTemplateInput(false); setNewTemplateName(''); }} 
                  className="btn btn-secondary btn-sm"
                  style={{ height: '32px', fontSize: '0.75rem' }}
                  disabled={addingTemplate}
                >
                  Cancel
                </button>
              </div>
            )}
            
            {mediaFileMissing && mediaType !== 'none' && (
              <div style={{
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                borderRadius: '6px',
                padding: '0.75rem 1rem',
                margin: '0.75rem 1rem 0.25rem 1rem',
                fontSize: '0.75rem',
                color: 'var(--color-coral)',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                lineHeight: '1.4'
              }}>
                <span style={{ fontSize: '1.25rem' }}>⚠️</span>
                <span>
                  <strong>Outreach image/media not found on the server.</strong> <br />
                  The previous server session ended or the container was restarted. Please <strong>re-upload</strong> the file or <strong>paste a valid URL</strong> below to restore it before launching campaigns.
                </span>
              </div>
            )}
            
            <div className="campaign-desc-container">
              <div className="template-editor-group">
                <div className="editor-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <label htmlFor="template-selector" className="editor-label" style={{ marginBottom: 0 }}>Template:</label>
                    <select
                      id="template-selector"
                      className="filter-select"
                      style={{ padding: '0.25rem 2rem 0.25rem 0.75rem', height: '32px', fontSize: '0.85rem' }}
                      value={selectedTemplateName}
                      onChange={(e) => handleTemplateChange(e.target.value)}
                    >
                      {templatesList.map(t => (
                        <option key={t.template_name} value={t.template_name}>
                          {t.template_name}
                        </option>
                      ))}
                    </select>
                    {templatesList.find(t => t.template_name === selectedTemplateName)?.is_active ? (
                      <span style={{ fontSize: '0.7rem', padding: '0.2rem 0.4rem', borderRadius: '4px', background: 'rgba(46, 204, 113, 0.2)', color: '#2ecc71', border: '1px solid rgba(46, 204, 113, 0.4)' }}>
                        Active
                      </span>
                    ) : (
                      <span style={{ fontSize: '0.7rem', padding: '0.2rem 0.4rem', borderRadius: '4px', background: 'rgba(241, 196, 15, 0.2)', color: '#f1c40f', border: '1px solid rgba(241, 196, 15, 0.4)' }}>
                        Inactive
                      </span>
                    )}
                  </div>
                  <button 
                    onClick={handleSaveTemplate} 
                    className="btn btn-secondary btn-sm" 
                    style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
                    disabled={saveStatus === 'saving'}
                  >
                    {saveStatus === 'saving' ? 'Saving...' : 'Save Media Settings'}
                  </button>
                </div>
                
                <textarea 
                  id="template-editor-textarea" 
                  className="template-editor" 
                  rows={4} 
                  placeholder="Dear [Parent Name], your child [Student Name]..."
                  value={templateText}
                  readOnly={true}
                  style={{ backgroundColor: 'rgba(0, 0, 0, 0.25)', color: 'var(--color-text-muted)', cursor: 'not-allowed' }}
                />
                
                <div className="editor-help-text" style={{ opacity: 0.7 }}>
                  ⚠️ Meta templates are pre-approved and read-only.
                </div>

                {/* Media Attachment Selector */}
                {mediaType !== 'none' && (
                  <div className="media-selector-group" style={{ marginTop: '0.75rem', borderTop: '1px solid var(--border-color)', paddingTop: '0.75rem' }}>
                    <span className="editor-label" style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.75rem' }}>
                      Outreach Media Attachment ({mediaType === 'image' ? 'Image Required' : 'Document Required'})
                    </span>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {!mediaUrl ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <input 
                            type="file" 
                            accept={mediaType === 'image' ? "image/*" : ".pdf,.docx,.xlsx"} 
                            onChange={handleMediaUpload} 
                            style={{ display: 'none' }} 
                            id="media-file-input" 
                          />
                          <button 
                            type="button" 
                            className="btn btn-secondary btn-sm" 
                            onClick={() => document.getElementById('media-file-input').click()}
                            disabled={mediaUploading}
                          >
                            {mediaUploading ? 'Uploading...' : `Upload ${mediaType === 'image' ? 'Image' : 'Document'}`}
                          </button>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                            Or paste a public URL below:
                          </span>
                        </div>
                      ) : (
                        <div className="column-pill" style={{ width: 'max-content', paddingRight: '0.5rem' }}>
                          <span style={{ wordBreak: 'break-all' }}>{mediaFilename || 'Attachment uploaded'}</span>
                          <button 
                            type="button" 
                            style={{ background: 'none', border: 'none', color: 'var(--color-coral)', cursor: 'pointer', fontWeight: 'bold', marginLeft: '0.5rem' }}
                            onClick={() => { setMediaUrl(null); setMediaFilename(''); setSaveStatus('unsaved'); }}
                          >
                            &times;
                          </button>
                        </div>
                      )}
                      
                      <input 
                        type="text" 
                        placeholder={mediaType === 'image' ? "https://example.com/image.jpg" : "https://example.com/fees.pdf"}
                        value={mediaUrl || ''}
                        onChange={(e) => { setMediaUrl(e.target.value); setMediaFilename(e.target.value.split('/').pop()); setSaveStatus('unsaved'); }}
                        className="template-editor"
                        style={{ padding: '0.4rem 0.6rem', fontSize: '0.75rem' }}
                      />
                    </div>
                  </div>
                )}
              </div>
              
              <div className="message-preview">
                <div className="preview-header">
                  <span className="preview-label">Compiled Message Preview (Sample Record)</span>
                  <span className={`save-status-indicator ${saveStatus === 'unsaved' ? 'unsaved' : 'synced'}`}>
                    {saveStatus === 'unsaved' ? 'Unsaved Changes' : 'Synced'}
                  </span>
                </div>

                {/* Media Preview Box */}
                {mediaType !== 'none' && mediaUrl && (
                  <div style={{ marginBottom: '0.75rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem', display: 'flex', justifyContent: 'center', backgroundColor: '#f1f5f9', borderRadius: '4px', overflow: 'hidden' }}>
                    {mediaType === 'image' ? (
                      <img 
                        src={mediaUrl.startsWith('/static/') ? `${API_BASE}${mediaUrl}` : mediaUrl} 
                        alt="Preview" 
                        style={{ maxWidth: '100%', maxHeight: '150px', objectFit: 'contain' }}
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', backgroundColor: '#ffffff', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', fontSize: '0.813rem', width: '90%' }}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-coral)" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                        <span style={{ fontWeight: '600', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexGrow: 1 }}>
                          {mediaFilename || 'document.pdf'}
                        </span>
                        <a 
                          href={mediaUrl.startsWith('/static/') ? `${API_BASE}${mediaUrl}` : mediaUrl} 
                          target="_blank" 
                          rel="noreferrer"
                          style={{ fontSize: '0.75rem', color: 'var(--color-blue)', textDecoration: 'none', fontWeight: 'bold' }}
                        >
                          View File
                        </a>
                      </div>
                    )}
                  </div>
                )}

                <p className="preview-body">
                  {renderLivePreviewText()}
                </p>
              </div>
            </div>

            {/* Template variable requirement checklist & spreadsheet warning */}
            {requiredFields.length > 0 ? (
              <div style={{ margin: '0rem 1rem 0.75rem 1rem' }}>
                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', display: 'block', marginBottom: '0.25rem' }}>
                  Required template variables:
                </span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                  {requiredFields.map(f => {
                    const isMissing = missingFields.includes(f);
                    return (
                      <span 
                        key={f} 
                        style={{ 
                          fontSize: '0.7rem', 
                          padding: '0.15rem 0.4rem', 
                          borderRadius: '4px', 
                          background: isMissing ? 'rgba(239, 68, 68, 0.15)' : 'rgba(46, 204, 113, 0.15)', 
                          color: isMissing ? '#fc8181' : '#2ecc71',
                          border: isMissing ? '1px solid rgba(239, 68, 68, 0.3)' : '1px solid rgba(46, 204, 113, 0.3)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.25rem'
                        }}
                      >
                        {isMissing ? '❌' : '✅'} {f}
                      </span>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: '0.75rem', color: 'rgba(46, 204, 113, 0.8)', margin: '0rem 1rem 0.75rem 1rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <span>✅ Static template (no variables required). Can send directly.</span>
              </div>
            )}

            {missingFields.length > 0 && (
              <div style={{
                backgroundColor: 'rgba(239, 68, 68, 0.08)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                borderRadius: '6px',
                padding: '0.75rem 1rem',
                margin: '0rem 1rem 0.75rem 1rem',
                fontSize: '0.75rem',
                color: '#fc8181',
                lineHeight: '1.4'
              }}>
                <strong>⚠️ Spreadsheet Header Mismatch</strong> <br />
                Your uploaded spreadsheet is missing columns for: <strong>{missingFields.join(', ')}</strong>. Please upload a spreadsheet with the matching headers to send.
              </div>
            )}

            <div className="campaign-actions">
              <button 
                onClick={handleLaunchBroadcast} 
                className="btn btn-primary btn-lg btn-block"
                disabled={missingFields.length > 0}
                style={{
                  cursor: missingFields.length > 0 ? 'not-allowed' : 'pointer',
                  opacity: missingFields.length > 0 ? 0.6 : 1
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                  <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
                Launch Broadcast Campaign {stats.unsent > 0 ? `(${stats.unsent} pending)` : ''}
              </button>
            </div>
          </div>
        </section>

        {/* Data Table Filters & Grid Panel */}
        <section className="glass-panel grid-panel">
          <div className="grid-panel-header">
            <div className="funnel-filter-bar">
              <div className="filter-group">
                <span className="filter-label">1. Dispatch</span>
                <select 
                  value={dispatchFilter} 
                  onChange={(e) => handleDispatchFilterChange(e.target.value)} 
                  className="filter-select"
                >
                  <option value="all">All Dispatch States</option>
                  <option value="unsent">Unsent (Pending)</option>
                  <option value="sent">Sent</option>
                  <option value="failed">Failed</option>
                </select>
              </div>

              <div className="filter-group">
                <span className="filter-label">2. Delivery</span>
                <select 
                  value={deliveryFilter} 
                  onChange={(e) => handleDeliveryFilterChange(e.target.value)} 
                  className="filter-select"
                >
                  <option value="all">All Delivery States</option>
                  <option value="undelivered">Undelivered</option>
                  <option value="delivered">Delivered</option>
                </select>
              </div>

              <div className="filter-group">
                <span className="filter-label">3. Read Status</span>
                <select 
                  value={readFilter} 
                  onChange={(e) => handleReadFilterChange(e.target.value)} 
                  className="filter-select"
                >
                  <option value="all">All Read States</option>
                  <option value="not_read">Not Read</option>
                  <option value="read">Read</option>
                </select>
              </div>

              <div className="filter-group">
                <span className="filter-label">4. Response</span>
                <select 
                  value={responseFilter} 
                  onChange={(e) => setResponseFilter(e.target.value)} 
                  className="filter-select"
                >
                  <option value="all">All Responses</option>
                  <option value="no_response">No Response</option>
                  <option value="interested">Interested</option>
                  <option value="not_interested">Not Interested</option>
                </select>
              </div>
              <div className="filter-group">
                <span className="filter-label">Branch</span>
                <select 
                  value={branchFilter} 
                  onChange={(e) => setBranchFilter(e.target.value)} 
                  className="filter-select"
                >
                  <option value="all">All Branches</option>
                  {branches.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>

              <div className="filter-group">
                <span className="filter-label">Template</span>
                <select 
                  value={templateFilter} 
                  onChange={(e) => setTemplateFilter(e.target.value)} 
                  className="filter-select"
                >
                  <option value="all">All Templates</option>
                  {templatesList.map((t) => (
                    <option key={t.template_name} value={t.template_name}>{t.template_name}</option>
                  ))}
                </select>
              </div>

               <div className="filter-group">
                <span className="filter-label">Pipeline Tag</span>
                <select 
                  value={pipelineTagFilter} 
                  onChange={(e) => setPipelineTagFilter(e.target.value)} 
                  className="filter-select"
                >
                  <option value="all">All Tags</option>
                  <option value="none">No Tag</option>
                  <option value="Interested">Interested</option>
                  <option value="Not Interested">Not Interested</option>
                </select>
              </div>
            </div>

            <div className="grid-header-actions" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="search-container">
                <svg className="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                <input 
                  type="text" 
                  placeholder="Search student, parent, phone..." 
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <button 
                onClick={handleExportExcel} 
                className="btn btn-success"
                style={{ height: '38px', display: 'inline-flex', alignItems: 'center', gap: '0.5rem', whiteSpace: 'nowrap', padding: '0.5rem 1rem' }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                Export Excel
              </button>
            </div>
          </div>

          {selectedRecordIds.length > 0 && (
            <div className="bulk-action-bar" style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: '#eff6ff',
              border: '1px solid #bfdbfe',
              borderRadius: 'var(--radius-sm)',
              padding: '0.75rem 1.25rem',
              margin: '0.75rem 1.5rem',
              animation: 'fadeIn 0.2s ease-in-out'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#1e40af', fontWeight: '600', fontSize: '0.875rem' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                  <polyline points="22 4 12 14.01 9 11.01"></polyline>
                </svg>
                <span>{selectedRecordIds.length} candidate(s) selected for bulk outreach</span>
              </div>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button 
                  onClick={handleBulkSend} 
                  className="btn btn-primary btn-sm"
                  style={{ 
                    display: 'inline-flex', 
                    alignItems: 'center', 
                    gap: '0.5rem',
                    cursor: missingFields.length > 0 ? 'not-allowed' : 'pointer',
                    opacity: missingFields.length > 0 ? 0.6 : 1
                  }}
                  disabled={missingFields.length > 0}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                  </svg>
                  Send Outreach
                </button>
                <button 
                  onClick={() => setSelectedRecordIds([])} 
                  className="btn btn-secondary btn-sm"
                >
                  Clear Selection
                </button>
              </div>
            </div>
          )}

          <div className="table-container">
            <div style={{
              padding: '0.75rem 1.5rem',
              backgroundColor: '#f8fafc',
              borderBottom: '1px solid var(--border-color)',
              fontSize: '0.85rem',
              color: 'var(--color-text-muted)',
              fontWeight: '500',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem'
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </svg>
              <span>Showing delivery status specifically for template: <strong>{templateFilter === 'all' ? selectedTemplateName : templateFilter}</strong></span>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: '40px', textAlign: 'center' }}>
                    <input 
                      type="checkbox" 
                      style={{ 
                        cursor: records.filter(isRecordEligibleForBulk).length > 0 ? 'pointer' : 'not-allowed', 
                        scale: '1.1' 
                      }}
                      checked={
                        records.length > 0 && 
                        records.filter(isRecordEligibleForBulk).length > 0 &&
                        records.filter(isRecordEligibleForBulk).every(r => selectedRecordIds.includes(r.id))
                      }
                      disabled={records.filter(isRecordEligibleForBulk).length === 0}
                      onChange={(e) => {
                        const eligiblePageIds = records.filter(isRecordEligibleForBulk).map(r => r.id);
                        if (e.target.checked) {
                          setSelectedRecordIds(prev => [...new Set([...prev, ...eligiblePageIds])]);
                        } else {
                          setSelectedRecordIds(prev => prev.filter(id => !eligiblePageIds.includes(id)));
                        }
                      }}
                    />
                  </th>
                  <th>Student Details</th>
                  <th>Parent Details</th>
                  <th>Branch</th>
                  <th>Sent Template</th>
                  <th>Phone Number</th>
                  <th>Delivery Status</th>
                  <th>Response</th>
                  <th>Pipeline Tag</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {gridLoading ? (
                  <tr className="state-loading">
                    <td colSpan={10}>
                      <div className="loading-spinner-container">
                        <div className="spinner"></div>
                        <span>Loading records...</span>
                      </div>
                    </td>
                  </tr>
                ) : gridError ? (
                  <tr className="state-empty">
                    <td colSpan={10}>
                      <div className="empty-container">
                        <svg className="empty-icon text-coral" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                          <line x1="12" y1="9" x2="12" y2="13"></line>
                          <line x1="12" y1="17" x2="12.01" y2="17"></line>
                        </svg>
                        <span className="empty-title text-coral">Data Query Failed</span>
                        <span className="empty-desc">{gridError}</span>
                      </div>
                    </td>
                  </tr>
                ) : records.length === 0 ? (
                  <tr className="state-empty">
                    <td colSpan={10}>
                      <div className="empty-container">
                        <svg className="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <circle cx="12" cy="12" r="10"></circle>
                          <line x1="12" y1="8" x2="12" y2="12"></line>
                          <line x1="12" y1="16" x2="12.01" y2="16"></line>
                        </svg>
                        <span className="empty-title">No Records Found</span>
                        <span className="empty-desc">Upload an Excel or adjust filters to populate contacts.</span>
                      </div>
                    </td>
                  </tr>
                ) : (
                  records.map((rec) => {
                    const delStatusLower = (rec.delivery_status || 'unsent').toLowerCase();
                    let delBadge = 'badge-unsent';
                    if (delStatusLower === 'sent') delBadge = 'badge-sent';
                    if (delStatusLower === 'delivered') delBadge = 'badge-delivered';
                    if (delStatusLower === 'read') delBadge = 'badge-read';
                    if (delStatusLower === 'failed') delBadge = 'badge-failed';

                    const respLower = (rec.parent_response || 'no response').toLowerCase();
                    let respBadge = 'badge-no-response';
                    if (respLower === 'interested') respBadge = 'badge-interested';
                    if (respLower === 'not interested') respBadge = 'badge-not-interested';

                    const tagVal = rec.pipeline_tag;
                    const isMainTag = ['Contacted', 'Interested', 'Not Interested'].includes(tagVal);
                    let tagBadge = '';
                    if (tagVal === 'Contacted') tagBadge = 'badge-tag-contacted';
                    if (tagVal === 'Interested') tagBadge = 'badge-tag-interested';
                    if (tagVal === 'Not Interested') tagBadge = 'badge-tag-not-interested';

                    return (
                      <tr key={rec.id}>
                        <td style={{ textAlign: 'center' }}>
                          <input 
                            type="checkbox" 
                            style={{ 
                              cursor: isRecordEligibleForBulk(rec) ? 'pointer' : 'not-allowed',
                              opacity: isRecordEligibleForBulk(rec) ? 1 : 0.5
                            }}
                            checked={selectedRecordIds.includes(rec.id)}
                            disabled={!isRecordEligibleForBulk(rec)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedRecordIds(prev => [...prev, rec.id]);
                              } else {
                                setSelectedRecordIds(prev => prev.filter(id => id !== rec.id));
                              }
                            }}
                          />
                        </td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span className="cell-title">{rec.student_name}</span>
                            {rec.unresolved_notes_count > 0 && (
                              <span 
                                title={`${rec.unresolved_notes_count} pending notes/actions`} 
                                style={{
                                  backgroundColor: '#fffbeb',
                                  color: '#d97706',
                                  border: '1px solid #fde68a',
                                  borderRadius: '50%',
                                  width: '18px',
                                  height: '18px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  fontSize: '0.7rem',
                                  fontWeight: 'bold',
                                  cursor: 'help'
                                }}
                              >
                                📝
                              </span>
                            )}
                          </div>
                          <span className="cell-subtitle">ID: {rec.id}</span>
                        </td>
                        <td>
                          <span className="cell-title">{rec.parent_name}</span>
                          <span className="cell-subtitle">Parent</span>
                        </td>
                        <td>
                          <span className="cell-title">{rec.selected_branch}</span>
                        </td>
                        <td>
                          <span className="cell-title" style={{ fontSize: '0.8rem', opacity: rec.sent_template ? 1 : 0.5 }}>
                            {rec.sent_template || '—'}
                          </span>
                        </td>
                        <td>
                          <span className="cell-title">+{rec.phone_number}</span>
                        </td>
                        <td>
                          <span className={`badge ${delBadge}`}>
                            <span className="badge-dot"></span>
                            {rec.delivery_status}
                          </span>
                        </td>
                        <td>
                          <span className={`badge ${respBadge}`}>
                        {rec.parent_response}
                          </span>
                        </td>
                        <td>
                          {isMainTag ? (
                            <span className={`badge ${tagBadge}`}>
                              {tagVal}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>—</span>
                          )}
                        </td>
                        <td className="text-right">
                          <div className="table-actions">
                            <button 
                              onClick={() => handleSendSingle(rec.id)} 
                              className="btn btn-secondary btn-sm"
                              disabled={rec.parent_response === 'Interested' || missingFields.length > 0}
                              title={
                                rec.parent_response === 'Interested' 
                                  ? "Parent has confirmed interest" 
                                  : (missingFields.length > 0 ? "Spreadsheet is missing required headers" : "")
                              }
                            >
                              {rec.campaign_status === 'Pending' ? 'Send' : 'Resend'}
                            </button>

                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Table Pagination Footer */}
          <div className="grid-footer">
            <span className="footer-text">
              Showing {records.length === 0 ? 0 : (currentPage - 1) * RECORDS_PER_PAGE + 1} to{' '}
              {Math.min(currentPage * RECORDS_PER_PAGE, totalCount)} of {totalCount} records
            </span>
            <div className="pagination-controls">
              <button 
                onClick={() => changePage(-1)} 
                className="btn btn-secondary btn-sm" 
                disabled={currentPage <= 1}
              >
                Previous
              </button>
              <span className="page-indicator">Page {currentPage} of {totalPages || 1}</span>
              <button 
                onClick={() => changePage(1)} 
                className="btn btn-secondary btn-sm" 
                disabled={currentPage >= totalPages}
              >
                Next
              </button>
            </div>
          </div>
        </section>
        </div>

        <div className="chat-container" style={{ display: activeView === 'chat' ? 'grid' : 'none' }}>
            {/* 1. Recent Chats List Pane */}
            <div className="glass-panel chat-list-panel">
              <div className="chat-search-wrapper" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', width: '100%' }}>
                  <input 
                    type="text" 
                    placeholder="Search student, phone..." 
                    className="chat-search-input"
                    value={chatSearchText}
                    onChange={(e) => setChatSearchText(e.target.value)}
                    style={{ flexGrow: 1 }}
                  />
                  <button 
                    className="btn btn-secondary btn-sm mobile-only-flex" 
                    onClick={() => setMobileActiveSubView('rules')}
                    style={{ whiteSpace: 'nowrap', padding: '0.5rem' }}
                  >
                    🤖 Rules
                  </button>
                </div>
                <select 
                  className="filter-select" 
                  style={{ width: '100%', padding: '0.45rem 0.75rem', fontSize: '0.813rem', height: '34px' }}
                  value={chatBranchFilter}
                  onChange={(e) => setChatBranchFilter(e.target.value)}
                >
                  <option value="all">All Branches</option>
                  {branches.map(b => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>
              <div className="conversations-scrollable">
                {chatsList.filter(chat => {
                  const matchSearch = chat.record.student_name.toLowerCase().includes(chatSearchText.toLowerCase()) ||
                                      chat.record.phone_number.includes(chatSearchText);
                  const matchBranch = chatBranchFilter === 'all' || chat.record.selected_branch === chatBranchFilter;
                  return matchSearch && matchBranch;
                }).map(chat => {
                  const isActive = chat.record.id === activeChatRecordId;
                  const lastMsg = chat.last_message;
                  const initials = chat.record.student_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
                  const lastMsgTime = lastMsg ? new Date(lastMsg.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '';
                  
                  const tagVal = chat.record.pipeline_tag;
                  const parentResp = chat.record.parent_response;
                  
                  let showTag = false;
                  let tagBadge = '';
                  let tagText = '';
                  
                  if (tagVal === 'Contacted') {
                    showTag = true;
                    tagBadge = 'badge-tag-contacted';
                    tagText = 'Contacted';
                  } else if (tagVal === 'Interested') {
                    showTag = true;
                    tagBadge = 'badge-tag-interested';
                    tagText = 'Interested';
                  } else if (tagVal === 'Not Interested') {
                    showTag = true;
                    tagBadge = 'badge-tag-not-interested';
                    tagText = 'Not Interested';
                  } else if (parentResp === 'Interested') {
                    showTag = true;
                    tagBadge = 'badge-interested';
                    tagText = 'Interested';
                  } else if (parentResp === 'Not Interested') {
                    showTag = true;
                    tagBadge = 'badge-not-interested';
                    tagText = 'Not Interested';
                  }

                  return (
                    <div 
                      key={chat.record.id} 
                      className={`conversation-item ${isActive ? 'active' : ''}`}
                      onClick={() => {
                        setActiveChatRecordId(chat.record.id);
                        fetchChatHistory(chat.record.id);
                        fetchChatNotes(chat.record.id);
                        setActiveChatSubTab('chat');
                        setMobileActiveSubView('thread');
                        setSelectedChatTemplate('');
                        setForceFreeForm(false);
                      }}
                    >
                      <div className="avatar-circle">{initials}</div>
                      <div className="conv-details">
                        <div className="conv-name-row" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', justifyContent: 'space-between', width: '100%' }}>
                          <span className="conv-name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100px', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                            {chat.record.student_name}
                            {chat.record.unresolved_notes_count > 0 && (
                              <span title={`${chat.record.unresolved_notes_count} pending notes`} style={{ fontSize: '0.85rem' }}>📝</span>
                            )}
                          </span>
                          {showTag && (
                            <span className={`badge ${tagBadge}`} style={{ fontSize: '0.65rem', padding: '0.15rem 0.35rem', fontWeight: '600' }}>{tagText}</span>
                          )}
                          <span className="conv-time" style={{ whiteSpace: 'nowrap' }}>{lastMsgTime}</span>
                        </div>
                        <p className="conv-msg-preview">{lastMsg ? lastMsg.message_text : 'No messages yet'}</p>
                      </div>
                    </div>
                  );
                })}
                {chatsList.length === 0 && (
                  <div className="chat-empty-state">
                    <p>No active conversations yet.</p>
                  </div>
                )}
              </div>
            </div>

            {/* 2. Active Chat History Thread Pane */}
            <div className="glass-panel chat-window-panel">
              {activeChatRecordId ? (
                <>
                  <div className="chat-header" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <button 
                      className="btn btn-secondary btn-sm mobile-only-flex" 
                      onClick={() => setMobileActiveSubView('list')}
                      style={{ padding: '0.4rem 0.6rem' }}
                    >
                      ← Back
                    </button>
                    <div className="chat-header-title" style={{ flexGrow: 1 }}>
                      {(() => {
                        const activeChat = chatsList.find(c => c.record.id === activeChatRecordId);
                        return (
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', flexWrap: 'wrap', gap: '0.5rem' }}>
                            <div>
                              <h4>{activeChat ? activeChat.record.student_name : 'Loading...'}</h4>
                              <p className="chat-header-meta">
                                {activeChat ? `${activeChat.record.phone_number} | Branch: ${activeChat.record.selected_branch}` : ''}
                              </p>
                            </div>
                            {activeChat && (
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                                {activeChat.record.parent_response === 'Interested' && 
                                 activeChat.record.pipeline_tag !== 'Interested' && 
                                 activeChat.record.pipeline_tag !== 'Not Interested' && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                    <button 
                                      onClick={() => handleUpdateTag(activeChat.record.id, 'Interested')}
                                      className="btn-tag-interested"
                                      title="Mark as Interested"
                                    >
                                      Mark Interested
                                    </button>
                                    <button 
                                      onClick={() => handleUpdateTag(activeChat.record.id, 'Not Interested')}
                                      className="btn-tag-not-interested"
                                      title="Mark as Not Interested"
                                    >
                                      Mark Not Interested
                                    </button>
                                  </div>
                                )}
                                {activeChat.record.pipeline_tag && ['Contacted', 'Interested', 'Not Interested'].includes(activeChat.record.pipeline_tag) && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                                    <span style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--color-text-muted)' }}>Tag:</span>
                                    <span 
                                      className={`badge-tag-${activeChat.record.pipeline_tag.toLowerCase().replace(' ', '-')}`}
                                      style={{ 
                                        padding: '0.25rem 0.5rem', 
                                        borderRadius: '4px', 
                                        fontSize: '0.75rem', 
                                        fontWeight: '600',
                                        display: 'inline-block' 
                                      }}
                                    >
                                      {activeChat.record.pipeline_tag}
                                    </span>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                  
                  <div className="chat-window-tabs" style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', backgroundColor: '#f8fafc' }}>
                    <button 
                      onClick={() => setActiveChatSubTab('chat')}
                      style={{
                        flex: 1,
                        padding: '0.75rem',
                        fontSize: '0.85rem',
                        fontWeight: '600',
                        color: activeChatSubTab === 'chat' ? 'var(--color-blue)' : 'var(--color-text-muted)',
                        borderBottom: activeChatSubTab === 'chat' ? '2px solid var(--color-blue)' : 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        borderTop: 'none',
                        borderLeft: 'none',
                        borderRight: 'none'
                      }}
                    >
                      💬 Chat History
                    </button>
                    <button 
                      onClick={() => setActiveChatSubTab('notes')}
                      style={{
                        flex: 1,
                        padding: '0.75rem',
                        fontSize: '0.85rem',
                        fontWeight: '600',
                        color: activeChatSubTab === 'notes' ? 'var(--color-blue)' : 'var(--color-text-muted)',
                        borderBottom: activeChatSubTab === 'notes' ? '2px solid var(--color-blue)' : 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        borderTop: 'none',
                        borderLeft: 'none',
                        borderRight: 'none'
                      }}
                    >
                      📝 Counselor Notes {chatNotes.length > 0 ? `(${chatNotes.length})` : ''}
                    </button>
                  </div>

                  {activeChatSubTab === 'chat' ? (
                    <>
                      <div className="chat-messages-area">
                        {chatHistory.map((msg, index) => {
                          const bubbleClass = msg.sender === 'parent' ? 'parent' : msg.sender === 'counselor' ? 'counselor' : 'system';
                          const senderLabel = msg.sender === 'parent' ? 'Student/Parent' : msg.sender === 'counselor' ? 'Counselor' : 'Bot / Outreach';
                          const msgTime = new Date(msg.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                          return (
                            <div key={msg.id || index} className={`message-bubble-row ${bubbleClass}`}>
                              <div className="message-bubble">{msg.message_text}</div>
                              <div className="message-meta-info">
                                <span>{senderLabel}</span> • <span>{msgTime}</span>
                              </div>
                            </div>
                          );
                        })}
                        {chatHistory.length === 0 && (
                          <div className="chat-empty-state">
                            <p>No messages in this chat yet.</p>
                          </div>
                        )}
                      </div>
                      <div className="chat-input-area" style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '1rem', borderTop: '1px solid var(--border-color)', backgroundColor: '#ffffff' }}>
                        {!chatSession.active ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
                            <div style={{ fontSize: '0.75rem', color: 'var(--color-amber)', display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 }}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <circle cx="12" cy="12" r="10"></circle>
                                <line x1="12" y1="8" x2="12" y2="12"></line>
                                <line x1="12" y1="16" x2="12.01" y2="16"></line>
                              </svg>
                              <span>WhatsApp 24h service session is inactive. Send a template message to resume:</span>
                            </div>
                            <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
                              <select 
                                value={selectedChatTemplate} 
                                onChange={(e) => setSelectedChatTemplate(e.target.value)} 
                                className="filter-select"
                                style={{ flexGrow: 1, padding: '0.5rem', fontSize: '0.85rem', height: '38px', backgroundPosition: 'right 0.65rem center' }}
                              >
                                <option value="">-- Select Template --</option>
                                {templatesList.map(t => (
                                  <option key={t.id} value={t.template_name}>{t.template_name}</option>
                                ))}
                              </select>
                              <button 
                                className="btn btn-primary"
                                onClick={sendManualTemplateMessage}
                                disabled={sendingChat || !selectedChatTemplate}
                                style={{ backgroundColor: 'var(--color-amber)', borderColor: 'var(--color-amber)', height: '38px', padding: '0 1rem', fontSize: '0.8rem' }}
                              >
                                {sendingChat ? 'Sending...' : 'Send Template'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%' }}>
                            {/* Status Line */}
                            <div style={{ fontSize: '0.72rem', color: 'var(--color-emerald)', display: 'flex', alignItems: 'center', gap: '4px', fontWeight: 600, paddingLeft: '2px' }}>
                              <span style={{ width: '6px', height: '6px', backgroundColor: 'var(--color-emerald)', borderRadius: '50%', display: 'inline-block' }}></span>
                              <span>WhatsApp Session Active (Expires in {formatSecondsToHMS(secondsLeft)})</span>
                            </div>

                            {/* Optional Template Quick Sender */}
                            <div style={{ display: 'flex', gap: '8px', width: '100%', alignItems: 'center', borderBottom: '1px dashed #e2e8f0', paddingBottom: '8px' }}>
                              <span style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>Or Send Template:</span>
                              <select 
                                value={selectedChatTemplate} 
                                onChange={(e) => setSelectedChatTemplate(e.target.value)} 
                                className="filter-select"
                                style={{ flexGrow: 1, padding: '0.25rem 0.5rem', fontSize: '0.85rem', height: '32px', backgroundPosition: 'right 0.65rem center' }}
                              >
                                <option value="">-- Select Template --</option>
                                {templatesList.map(t => (
                                  <option key={t.id} value={t.template_name}>{t.template_name}</option>
                                ))}
                              </select>
                              <button 
                                className="btn btn-secondary"
                                onClick={sendManualTemplateMessage}
                                disabled={sendingChat || !selectedChatTemplate}
                                style={{ height: '32px', padding: '0 0.75rem', fontSize: '0.75rem' }}
                              >
                                Send Template
                              </button>
                            </div>

                            {/* Free-form Input Text Box */}
                            <div style={{ display: 'flex', gap: '8px', width: '100%', alignItems: 'center' }}>
                              <textarea 
                                placeholder="Type your response here..." 
                                className="chat-input-box"
                                value={typedMessage}
                                onChange={(e) => setTypedMessage(e.target.value)}
                                style={{ flexGrow: 1, height: '44px', margin: 0 }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    sendManualMessage();
                                  }
                                }}
                              />
                              <button 
                                className="btn btn-primary"
                                onClick={sendManualMessage}
                                disabled={sendingChat || !typedMessage.trim()}
                                style={{ height: '44px', padding: '0 1.25rem' }}
                              >
                                {sendingChat ? 'Sending...' : 'Send'}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="chat-messages-area" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '1.25rem', height: 'calc(100% - 100px)' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', flexGrow: 1, overflowY: 'auto', paddingRight: '0.25rem' }}>
                        {chatNotes.map((note) => {
                          const noteTime = new Date(note.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
                          const isResolved = note.resolved;
                          return (
                            <div key={note.id} style={{
                              backgroundColor: isResolved ? 'var(--color-grey-light)' : '#fffbeb',
                              border: isResolved ? '1px solid var(--color-grey-border)' : '1px solid var(--color-amber-border)',
                              borderRadius: 'var(--radius-sm)',
                              padding: '0.85rem 1rem',
                              boxShadow: '0 1px 2px rgba(0,0,0,0.02)',
                              textAlign: 'left',
                              opacity: isResolved ? 0.75 : 1
                            }}>
                              <p style={{ 
                                fontSize: '0.875rem', 
                                color: isResolved ? 'var(--color-grey)' : '#1e293b', 
                                lineHeight: '1.4', 
                                whiteSpace: 'pre-wrap', 
                                margin: 0,
                                textDecoration: isResolved ? 'line-through' : 'none'
                              }}>
                                {note.note_text}
                              </p>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.7rem', color: isResolved ? 'var(--color-grey)' : 'var(--color-amber)', marginTop: '0.5rem', fontWeight: '500' }}>
                                <span>By: {note.created_by} • {noteTime}</span>
                                {isResolved ? (
                                  <span style={{ color: 'var(--color-emerald)', fontWeight: 'bold' }}>✓ Resolved</span>
                                ) : (
                                  <button
                                    onClick={() => resolveChatNote(note.id)}
                                    style={{
                                      backgroundColor: 'var(--color-emerald)',
                                      color: 'white',
                                      border: 'none',
                                      borderRadius: 'var(--radius-sm)',
                                      padding: '0.2rem 0.5rem',
                                      fontSize: '0.65rem',
                                      cursor: 'pointer',
                                      fontWeight: '600'
                                    }}
                                  >
                                    Resolve
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                        {chatNotes.length === 0 && (
                          <div className="chat-empty-state" style={{ padding: '2rem' }}>
                            <p>No internal notes recorded for this candidate yet.</p>
                          </div>
                        )}
                      </div>
                      <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        <textarea 
                          placeholder="Type internal counselor notes here... (e.g. details from call, parent responses, etc.)"
                          value={newNoteText}
                          onChange={(e) => setNewNoteText(e.target.value)}
                          style={{
                            width: '100%',
                            minHeight: '80px',
                            padding: '0.75rem',
                            borderRadius: 'var(--radius-sm)',
                            border: '1px solid var(--border-color)',
                            fontSize: '0.875rem',
                            resize: 'vertical',
                            fontFamily: 'inherit'
                          }}
                        />
                        <button 
                          onClick={addChatNote}
                          disabled={addingNote || !newNoteText.trim()}
                          className="btn btn-primary"
                          style={{ alignSelf: 'flex-end', padding: '0.5rem 1.25rem' }}
                        >
                          {addingNote ? 'Saving...' : 'Save Note'}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="chat-empty-state">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                  </svg>
                  <h4 style={{ marginTop: '1rem', fontWeight: 600 }}>Select a Conversation</h4>
                  <p>Click a student from the active list to view chat history and reply.</p>
                </div>
              )}
            </div>

            {/* 3. Auto-Reply Configurator Panel */}
            <div className="glass-panel rules-panel">
              <div className="panel-header" style={{ padding: '1rem 1.5rem', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <button 
                  className="btn btn-secondary btn-sm mobile-only-flex" 
                  onClick={() => setMobileActiveSubView('list')}
                  style={{ padding: '0.4rem 0.6rem' }}
                >
                  ← Back
                </button>
                <div style={{ flexGrow: 1 }}>
                  <h4 style={{ fontWeight: 700 }}>Auto-Reply Rules</h4>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.125rem' }}>Configure bot responses for student keywords.</p>
                </div>
              </div>
              <div className="rules-list">
                {rulesList.map(rule => (
                  <div key={rule.id} className="rule-item">
                    <div className="rule-header-row">
                      <span className={`rule-keyword-badge ${rule.keyword === 'default' ? 'default' : ''}`}>
                        {rule.keyword === 'default' ? 'fallback responder' : `keyword: ${rule.keyword}`}
                      </span>
                      {rule.keyword !== 'default' && (
                        <button 
                          className="rule-delete-btn"
                          onClick={() => deleteAutoReplyRule(rule.id)}
                          title="Delete Rule"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                          </svg>
                        </button>
                      )}
                    </div>
                    <p className="rule-text-preview">{rule.reply_text}</p>
                  </div>
                ))}
              </div>
              <div className="rule-form">
                <h5 style={{ fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.5rem' }}>Add Auto-Reply Rule</h5>
                <input 
                  type="text" 
                  placeholder="Keyword (e.g. hostel)" 
                  className="rule-input-field"
                  value={newRuleKeyword}
                  onChange={(e) => setNewRuleKeyword(e.target.value)}
                />
                <textarea 
                  placeholder="Auto-response message text..." 
                  className="rule-input-field"
                  style={{ height: '70px', resize: 'none' }}
                  value={newRuleReply}
                  onChange={(e) => setNewRuleReply(e.target.value)}
                />
                <button 
                  className="btn btn-primary btn-sm" 
                  style={{ width: '100%' }}
                  onClick={saveAutoReplyRule}
                  disabled={savingRule || !newRuleKeyword.trim() || !newRuleReply.trim()}
                >
                  {savingRule ? 'Saving...' : 'Add bot rule'}
                </button>
              </div>
            </div>
          </div>

        <div style={{ display: activeView === 'bot-builder' ? 'block' : 'none', height: '100%', width: '100%' }}>
          <FlowBuilder authFetch={authFetch} API_BASE={API_BASE} />
        </div>

        <div style={{ display: activeView === 'reminders' ? 'block' : 'none', height: '100%', width: '100%' }}>
          {/* Reminders Dashboard grid */}
          <div className="glass-panel" style={{ padding: '1.5rem', borderRadius: 'var(--radius-lg)' }}>
            <h4 style={{ marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span>📞</span> Active Callback & Scheduled Time Slots
            </h4>

            {reminders.length === 0 ? (
              <div className="empty-container" style={{ padding: '3.5rem 0' }}>
                <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>📅</div>
                <h5 className="empty-title">All Caught Up!</h5>
                <p className="empty-desc">No active call callbacks or scheduled time slots found from parents.</p>
              </div>
            ) : (
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Student/Parent Details</th>
                      <th>Phone Number</th>
                      <th>Branch</th>
                      <th>Scheduled Call Time</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reminders.map((rem) => {
                      const initials = rem.student_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
                      return (
                        <tr key={rem.id}>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                              <div className="avatar-circle" style={{ width: '32px', height: '32px', fontSize: '0.75rem' }}>{initials}</div>
                              <div>
                                <span className="cell-title">{rem.student_name}</span>
                                <span className="cell-subtitle" style={{ fontSize: '0.75rem' }}>Parent: {rem.parent_name}</span>
                              </div>
                            </div>
                          </td>
                          <td style={{ fontWeight: '500' }}>{rem.phone_number}</td>
                          <td>
                            <span className="badge badge-tag-contacted" style={{ fontSize: '0.75rem' }}>
                              {rem.selected_branch}
                            </span>
                          </td>
                          <td>
                            <span className="badge" style={{ 
                              fontSize: '0.8rem', 
                              padding: '0.35rem 0.75rem', 
                              backgroundColor: '#fffbeb', 
                              color: '#b45309', 
                              border: '1px solid #fde68a',
                              borderRadius: '6px',
                              fontWeight: '700',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '0.35rem'
                            }}>
                              📞 {rem.scheduled_call}
                            </span>
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                              <button
                                className="btn btn-primary btn-sm"
                                onClick={() => {
                                  // Open chat directly for this user
                                  setActiveChatRecordId(rem.id);
                                  fetchChatHistory(rem.id);
                                  fetchChatNotes(rem.id);
                                  setActiveChatSubTab('chat');
                                  setMobileActiveSubView('thread');
                                  setActiveView('chat');
                                  setSelectedChatTemplate('');
                                  setForceFreeForm(false);
                                }}
                              >
                                Open Chat
                              </button>
                              <button
                                className="btn btn-success btn-sm"
                                onClick={() => handleUpdateTag(rem.id, 'Interested')}
                              >
                                Mark Interested
                              </button>
                              <button
                                className="btn btn-danger btn-sm"
                                onClick={() => handleUpdateTag(rem.id, 'Not Interested')}
                              >
                                Not Interested
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

      </main>


      {/* 4. Global notifications toaster container */}
      <div className="toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.type} show`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ color: 'inherit', display: 'flex', alignItems: 'center' }}>
                {toast.type === 'success' && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
                )}
                {toast.type === 'error' && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
                )}
                {toast.type === 'info' && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
                )}
              </span>
              <span className="toast-content">{toast.message}</span>
            </div>
            <button onClick={() => removeToast(toast.id)} className="btn-toast-close">&times;</button>
          </div>
        ))}
      </div>

      {/* 5. Custom Premium Confirmation Modal */}
      {confirmModal.isOpen && (
        <div className="confirm-modal-overlay">
          <div className="confirm-modal-card">
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
              <div className="confirm-modal-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                  <line x1="12" y1="9" x2="12" y2="13"></line>
                  <line x1="12" y1="17" x2="12.01" y2="17"></line>
                </svg>
              </div>
              <div style={{ flexGrow: 1 }}>
                <h4 style={{
                  margin: 0,
                  fontSize: '1.125rem',
                  fontWeight: '600',
                  color: 'var(--text-primary)',
                  lineHeight: '1.5'
                }}>{confirmModal.title}</h4>
                <p style={{
                  margin: '0.5rem 0 0 0',
                  fontSize: '0.875rem',
                  color: 'var(--text-secondary)',
                  lineHeight: '1.5'
                }}>{confirmModal.message}</p>
              </div>
            </div>
            <div style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '0.75rem',
              marginTop: '0.5rem'
            }}>
              <button
                onClick={closeConfirmModal}
                className="btn btn-secondary"
                style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', height: 'auto' }}
              >
                Cancel
              </button>
              <button
                onClick={confirmModal.onConfirm}
                className="btn btn-primary"
                style={{ padding: '0.5rem 1rem', fontSize: '0.875rem', height: 'auto' }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;
